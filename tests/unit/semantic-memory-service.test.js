import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  markerFile,
  SemanticMemory,
  stateFile,
} from "../../server/features/assistants/runtimes/openclaw/semantic-memory.js";
import {
  applySemanticMemory,
  semanticMemorySections,
} from "../../server/features/assistants/runtimes/openclaw/openclaw-config/semantic-memory.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

// The owner's semantic memory search as a state machine (runtimes/openclaw/
// semantic-memory.js), with the Gateway, the assets and the index rebuild replaced:
// `start()` is what a Gateway launch does (compile, write openclaw.json, reconcile
// before the spawn) and answers the file the Gateway would spawn with.
const sha = runtimeManifest.embeddingModel.sha256;
const plugin = {
  id: "llama-cpp",
  directory: "/runtime/app/node_modules/@openclaw/llama-cpp-provider",
};
const refusal = (code) => Object.assign(Error(code), { code });

function fixture(t, { agents = ["ap-a1", "ap-a2"], installed = false, ...options } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-memory-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  const f = {
    paths,
    have: { server: installed, model: installed, verified: true },
    calls: [],
    rebuilds: [],
    views: [],
    fail: {},
    supervisor: { paths, runtime: { version: "2026.11.6", embeddingPlugin: plugin } },
    stateFile: path.join(paths.root, stateFile),
    markerFile: path.join(paths.state, markerFile),
  };
  const config = (semanticMemory) => {
    const base = {
      agents: {
        entries: Object.fromEntries([
          ["main", {}],
          ...agents.map((id) => [id, { memory: { search: { enabled: true } } }]),
        ]),
      },
      plugins: { allow: ["agentpier-teams", "memory-core"], load: { paths: ["/team"] } },
      memory: { search: { enabled: false, provider: "none", sources: ["memory"] } },
    };
    return applySemanticMemory(base, semanticMemorySections({ semanticMemory, port: 1 }));
  };
  f.create = () => {
    const memory = new SemanticMemory({
      supervisor: f.supervisor,
      restart: async () => {
        f.calls.push("restart");
        if (f.fail.restart) throw f.fail.restart;
        if (f.stopped) return;
        await f.start();
      },
      changed: () => f.views.push(memory?.status?.() ?? null),
      host: { platform: "linux", arch: "x64" },
      now: () => 1000,
      warn: (text) => f.calls.push(`warn:${text}`),
      reclaim: async () => f.calls.push("reclaim"),
      rebuild: async ({ semantic, onProgress, signal }) => {
        const mode = readJSON(paths.config).memory.search.provider;
        f.rebuilds.push({ mode, semantic });
        onProgress({ done: 0, total: agents.length });
        await f.gate?.promise;
        if (signal.aborted) throw refusal("MEMORY_INDEX_STOPPED");
        if (f.fail[mode]) throw f.fail[mode];
        onProgress({ done: agents.length, total: agents.length });
      },
      assets: {
        installedServer: () => (f.have.server ? { command: "/s" } : null),
        installedModel: () => (f.have.model ? { path: "/m" } : null),
        ensureServer: async () => {
          f.calls.push("ensureServer");
          if (f.fail.server) throw f.fail.server;
          f.have.server = true;
        },
        ensureModel: async ({ onProgress, signal }) => {
          f.calls.push("ensureModel");
          // As the real one: a model that is installed is not downloaded again.
          if (f.have.model) return;
          onProgress({ received: 10, total: 100 });
          await f.download?.promise;
          if (signal.aborted) throw refusal("EMBEDDING_DOWNLOAD_CANCELLED");
          if (f.fail.model) throw f.fail.model;
          f.have.model = f.have.verified = true;
        },
        verifyModel: async () => f.have.verified,
        removeServer: async () => {
          f.calls.push("removeServer");
          f.have.server = false;
        },
        removeModel: async (_root, _manifest, { partial = true } = {}) => {
          f.calls.push(partial ? "removeModel" : "removeModel:keepPartial");
          f.have.model = false;
        },
      },
      ...options,
    });
    return (f.memory = memory);
  };
  f.start = async () => {
    writePrivate(paths.config, config(f.memory.compiled(f.supervisor.runtime)));
    await f.memory.beforeSpawn();
    return readJSON(paths.config).memory.search.provider;
  };
  f.state = () => readJSON(f.stateFile, null);
  f.marker = () => readJSON(f.markerFile, null);
  f.switch = async (enabled, extra = {}) => {
    const answer = f.memory.set({
      enabled,
      revision: f.memory.status().revision,
      acceptTerms: true,
      ...extra,
    });
    await f.memory.idle();
    return answer;
  };
  f.create();
  return f;
}
const seen = (f) => [
  ...new Set(
    f.views
      .filter(Boolean)
      .map(({ state, progress }) =>
        progress?.phase ? `${state}:${progress.phase}` : state,
      ),
  ),
];

test("off is the default and a start then rebuilds nothing", async (t) => {
  const f = fixture(t);
  assert.deepEqual(f.memory.status(), {
    available: true,
    enabled: false,
    state: "off",
    progress: null,
    failure: null,
    pending: false,
    revision: 1,
    model: {
      id: "embeddinggemma-300m-qat-q8_0",
      size: 328577056,
      termsUrl: "https://ai.google.dev/gemma/terms",
    },
  });
  assert.equal(f.memory.compiled(f.supervisor.runtime), undefined);
  assert.equal(await f.start(), "none");
  assert.deepEqual(f.rebuilds, []);
  // No marker is written for the default; without one the indexes are keyword ones.
  assert.equal(f.marker(), null);
  assert.equal(f.state(), null);
});

test("switching on downloads, saves, restarts and rebuilds; every step is reported", async (t) => {
  const f = fixture(t);
  const answer = await f.switch(true);
  assert.equal(answer.state, "downloading");
  assert.deepEqual(
    f.calls.filter((c) => c !== "reclaim"),
    ["ensureServer", "ensureModel", "restart"],
  );
  assert.deepEqual(f.rebuilds, [{ mode: "local", semantic: true }]);
  assert.deepEqual(seen(f), [
    "downloading",
    "rebuilding:stopping",
    "rebuilding:indexing",
    "rebuilding:starting",
    "on",
  ]);
  const downloading = f.views.find(
    (view) => view?.state === "downloading" && view.progress.total,
  );
  assert.deepEqual(downloading.progress, { received: 10, total: 100 });
  const indexing = f.views.findLast((view) => view?.progress?.phase === "indexing");
  assert.deepEqual(indexing.progress, {
    target: "local",
    phase: "indexing",
    done: 2,
    total: 2,
  });
  assert.deepEqual(
    { ...f.memory.status(), model: 0 },
    {
      available: true,
      enabled: true,
      state: "on",
      progress: null,
      failure: null,
      pending: false,
      revision: 2,
      model: 0,
    },
  );
  assert.deepEqual(f.marker(), { mode: "local", model: sha });
  assert.deepEqual(f.state(), {
    enabled: true,
    revision: 2,
    failure: null,
    intent: null,
    journal: null,
  });
  // The compile of a later start names every path below the data directory.
  const compiled = f.memory.compiled(f.supervisor.runtime);
  assert.equal(compiled.plugin, plugin);
  for (const key of ["command", "model", "modelCacheDir", "preset", "pidFile"])
    assert.ok(
      compiled[key].startsWith(path.join(f.paths.root, "embeddings") + path.sep),
      key,
    );
  assert.equal(path.basename(compiled.model), runtimeManifest.embeddingModel.file);
  assert.equal(path.dirname(compiled.model), compiled.modelCacheDir);
  // A later start finds the indexes current and rebuilds nothing.
  assert.equal(await f.start(), "local");
  assert.equal(f.rebuilds.length, 1);
});

test("a model file that fails its checksum is downloaded again before it is used", async (t) => {
  const f = fixture(t, { installed: true });
  f.have.verified = false;
  await f.switch(true);
  assert.deepEqual(
    f.calls.filter((c) => !["reclaim", "restart"].includes(c)),
    ["ensureServer", "ensureModel", "removeModel", "ensureModel"],
  );
  assert.equal(f.memory.status().state, "on");
});

test("the switch refuses bad input, a stale revision, a second switch and missing terms", async (t) => {
  const f = fixture(t);
  const code = (input, expected, status = 409) =>
    assert.throws(
      () => f.memory.set(input),
      (error) => error.code === expected && error.status === status,
    );
  code({ enabled: "yes", revision: 1 }, "INVALID", 400);
  code({ enabled: true }, "INVALID", 400);
  code({ enabled: true, revision: 7, acceptTerms: true }, "CONFLICT");
  code({ enabled: true, revision: 1 }, "TERMS_REQUIRED", 400);
  // Nothing was saved or started by any refusal.
  assert.equal(f.state(), null);
  assert.deepEqual(f.calls, []);
  // Off while off answers the state and starts nothing.
  assert.equal(f.memory.set({ enabled: false, revision: 1 }).state, "off");
  f.download = Promise.withResolvers();
  f.memory.set({ enabled: true, revision: 1, acceptTerms: true });
  code({ enabled: false, revision: 2 }, "OPERATION_RUNNING");
  f.download.resolve();
  await f.memory.idle();
  assert.equal(f.memory.status().state, "on");
});

test("where it cannot run the status says why and switching on is refused", async (t) => {
  const cases = [
    [
      { host: { platform: "freebsd", arch: "x64" } },
      () => {},
      "EMBEDDING_PLATFORM_UNSUPPORTED",
    ],
    [
      {},
      (f) => (f.supervisor.runtime = { version: "2026.11.3" }),
      "RUNTIME_UPDATE_REQUIRED",
    ],
    [{}, (f) => (f.supervisor.runtime = undefined), "SERVICE_STOPPED"],
  ];
  for (const [options, prepare, reason] of cases) {
    const f = fixture(t, options);
    prepare(f);
    const status = f.memory.status();
    assert.equal(status.available, false, reason);
    assert.equal(status.reason, reason);
    assert.equal(status.state, "off");
    assert.throws(() => f.memory.set({ enabled: true, revision: 1, acceptTerms: true }), {
      code: reason,
    });
    assert.deepEqual(f.calls, []);
  }
});

test("a failed download leaves it off with the reason and restarts nothing", async (t) => {
  for (const [key, code] of [
    ["model", "EMBEDDING_DOWNLOAD_FAILED"],
    ["model", "EMBEDDING_CHECKSUM_MISMATCH"],
    ["model", "EMBEDDING_DISK_SPACE"],
    ["server", "EMBEDDING_SERVER_UNUSABLE"],
  ]) {
    const f = fixture(t);
    f.fail[key] = refusal(code);
    await f.switch(true);
    const status = f.memory.status();
    assert.equal(status.state, "failed", code);
    assert.equal(status.enabled, false);
    assert.deepEqual(status.failure, { code, at: 1000 });
    assert.equal(f.calls.includes("restart"), false);
    assert.deepEqual(f.rebuilds, []);
    assert.equal(f.state().intent, null);
    // Switching on again clears the reason and retries.
    f.fail = {};
    await f.switch(true);
    assert.equal(f.memory.status().state, "on");
    assert.equal(f.memory.status().failure, null);
  }
});

test("a refused restart leaves the previous setting in force", async (t) => {
  const f = fixture(t);
  f.fail.restart = Object.assign(Error("busy"), { status: 409, key: "active" });
  await f.switch(true);
  let status = f.memory.status();
  assert.equal(status.state, "failed");
  assert.equal(status.failure.code, "SERVICE_BUSY");
  assert.equal(f.memory.compiled(f.supervisor.runtime), undefined);
  assert.deepEqual(f.rebuilds, []);
  // The same for switching off: it stays on.
  f.fail = {};
  await f.switch(true);
  f.fail.restart = Object.assign(Error("busy"), { status: 409, key: "active" });
  await f.switch(false);
  status = f.memory.status();
  assert.equal(status.state, "on");
  assert.equal(status.enabled, true);
  assert.deepEqual(f.marker(), { mode: "local", model: sha });
});

test("a failed rebuild for local embeddings goes back to keyword search in the same start", async (t) => {
  const f = fixture(t);
  f.fail.local = refusal("MEMORY_INDEX_UNVERIFIED");
  await f.switch(true);
  // The rebuild for local failed; the file the Gateway spawns with is the keyword
  // one, and every index was rebuilt for it.
  assert.deepEqual(f.rebuilds, [
    { mode: "local", semantic: true },
    { mode: "none", semantic: false },
  ]);
  const config = readJSON(f.paths.config);
  assert.equal(config.memory.search.provider, "none");
  assert.equal(config.memory.search.local, undefined);
  assert.deepEqual(config.plugins.allow, ["agentpier-teams", "memory-core"]);
  assert.deepEqual(config.plugins.load.paths, ["/team"]);
  assert.equal(config.models?.providers?.["llama-cpp"], undefined);
  const status = f.memory.status();
  assert.equal(status.state, "failed");
  assert.deepEqual(status.failure, { code: "MEMORY_INDEX_UNVERIFIED", at: 1000 });
  assert.deepEqual(f.marker(), { mode: "keyword", model: null });
  assert.equal(f.state().journal, null);
  // The model nobody uses is removed, a partial download kept.
  assert.ok(f.calls.includes("removeModel:keepPartial"));
  // The next start is an ordinary keyword start.
  assert.equal(await f.start(), "none");
  assert.equal(f.rebuilds.length, 2);
});

test("a keyword rebuild that fails too is repeated by the next start", async (t) => {
  const f = fixture(t);
  f.fail.local = refusal("MEMORY_INDEX_FAILED");
  f.fail.none = refusal("MEMORY_INDEX_TIMEOUT");
  await f.switch(true);
  assert.equal(f.memory.status().enabled, false);
  assert.deepEqual(f.state().journal, { target: "keyword", since: 1000 });
  assert.ok(f.calls.some((call) => call.includes("MEMORY_INDEX_TIMEOUT")));
  f.fail = {};
  assert.equal(await f.start(), "none");
  assert.deepEqual(f.rebuilds.at(-1), { mode: "none", semantic: false });
  assert.equal(f.state().journal, null);
  assert.deepEqual(f.marker(), { mode: "keyword", model: null });
});

test("switching off rebuilds the keyword indexes and removes the model", async (t) => {
  const f = fixture(t);
  await f.switch(true);
  f.views.length = 0;
  const answer = await f.switch(false);
  assert.equal(answer.state, "rebuilding");
  assert.deepEqual(f.rebuilds.at(-1), { mode: "none", semantic: false });
  assert.deepEqual(seen(f), [
    "rebuilding:stopping",
    "rebuilding:indexing",
    "rebuilding:starting",
    "off",
  ]);
  assert.equal(f.views.findLast((v) => v?.progress)?.progress.target, "keyword");
  assert.equal(f.memory.status().state, "off");
  assert.deepEqual(f.marker(), { mode: "keyword", model: null });
  assert.ok(f.calls.includes("removeModel:keepPartial"));
  assert.equal(f.have.model, false);
});

test("an AgentPier restart in the middle of a rebuild switches it off as interrupted", async (t) => {
  const f = fixture(t);
  await f.switch(true);
  // The previous process died while rebuilding for local embeddings: its journal
  // and its intent are all that is left.
  writePrivate(f.stateFile, {
    ...f.state(),
    intent: { target: "local", since: 1 },
    journal: { target: "local", since: 1 },
  });
  f.rebuilds.length = 0;
  f.create();
  let status = f.memory.status();
  assert.equal(status.enabled, false);
  assert.equal(status.state, "failed");
  assert.deepEqual(status.failure, { code: "INTERRUPTED", at: 1000 });
  assert.equal(f.state().intent, null);
  // The next Gateway start compiles keyword search and rebuilds every index, some
  // of which the dead rebuild may have replaced.
  assert.equal(await f.start(), "none");
  assert.deepEqual(f.rebuilds, [{ mode: "none", semantic: false }]);
  assert.deepEqual(f.marker(), { mode: "keyword", model: null });
  assert.equal(f.state().journal, null);
  status = f.memory.status();
  assert.equal(status.state, "failed");
  assert.equal(status.failure.code, "INTERRUPTED");
});

test("an AgentPier restart during the download, or right after saving, recovers", async (t) => {
  // During the download: nothing was switched yet.
  const f = fixture(t);
  writePrivate(f.stateFile, {
    enabled: false,
    revision: 2,
    intent: { target: "local", since: 1 },
  });
  f.create();
  assert.equal(f.memory.status().state, "failed");
  assert.equal(f.memory.status().failure.code, "INTERRUPTED");
  assert.equal(await f.start(), "none");
  assert.deepEqual(f.rebuilds, []);
  // After the setting was saved and before the rebuild began: the next start
  // completes it.
  const g = fixture(t, { installed: true });
  writePrivate(g.stateFile, {
    enabled: true,
    revision: 2,
    intent: { target: "local", since: 1 },
  });
  g.create();
  assert.equal(g.memory.status().state, "on");
  assert.equal(g.memory.status().pending, true);
  assert.equal(await g.start(), "local");
  assert.deepEqual(g.rebuilds, [{ mode: "local", semantic: true }]);
  assert.equal(g.memory.status().pending, false);
  // A switch-off that was interrupted is completed the same way.
  const h = fixture(t, { installed: true });
  writePrivate(h.markerFile, { mode: "local", model: sha });
  writePrivate(h.stateFile, {
    enabled: false,
    revision: 3,
    intent: { target: "keyword", since: 1 },
    journal: { target: "keyword", since: 1 },
  });
  h.create();
  assert.equal(h.memory.status().state, "off");
  assert.equal(await h.start(), "none");
  assert.deepEqual(h.rebuilds, [{ mode: "none", semantic: false }]);
});

test("a rebuild a superseded start left unfinished counts as interrupted too", async (t) => {
  const f = fixture(t);
  await f.switch(true);
  writePrivate(f.stateFile, { ...f.state(), journal: { target: "local", since: 1 } });
  // The same process: the next start's compile finds the journal.
  assert.equal(await f.start(), "none");
  assert.equal(f.memory.status().failure.code, "INTERRUPTED");
  assert.deepEqual(f.rebuilds.at(-1), { mode: "none", semantic: false });
});

test("a runtime without local embeddings, or a missing asset, falls back at the start", async (t) => {
  const cases = [
    ["RUNTIME_UPDATE_REQUIRED", (f) => (f.supervisor.runtime = { version: "2026.11.3" })],
    ["EMBEDDING_MODEL_MISSING", (f) => (f.have.model = false)],
    ["EMBEDDING_SERVER_MISSING", (f) => (f.have.server = false)],
  ];
  for (const [code, lose] of cases) {
    const f = fixture(t);
    await f.switch(true);
    f.rebuilds.length = 0;
    // A rollback to the previous runtime, or files that are gone.
    lose(f);
    assert.equal(await f.start(), "none", code);
    assert.deepEqual(f.rebuilds, [{ mode: "none", semantic: false }]);
    const status = f.memory.status();
    assert.equal(status.state, "failed");
    assert.equal(status.enabled, false);
    assert.equal(status.failure.code, code);
    assert.deepEqual(f.marker(), { mode: "keyword", model: null });
  }
});

test("indexes a snapshot or a backup brought back are rebuilt for what the start compiles", async (t) => {
  // An update rollback restored indexes built for local embeddings (their marker
  // travels with them); the setting, which no snapshot holds, is off.
  const f = fixture(t);
  writePrivate(f.markerFile, { mode: "local", model: sha });
  assert.equal(await f.start(), "none");
  assert.deepEqual(f.rebuilds, [{ mode: "none", semantic: false }]);
  assert.deepEqual(f.marker(), { mode: "keyword", model: null });
  // The other way round: keyword indexes came back while the setting is on.
  const g = fixture(t);
  await g.switch(true);
  g.rebuilds.length = 0;
  fs.rmSync(g.markerFile);
  assert.equal(await g.start(), "local");
  assert.deepEqual(g.rebuilds, [{ mode: "local", semantic: true }]);
  assert.equal(g.memory.status().state, "on");
  // Indexes of another embedding model (a later release pins a new one).
  writePrivate(g.markerFile, { mode: "local", model: "0".repeat(64) });
  assert.equal(await g.start(), "local");
  assert.equal(g.rebuilds.length, 2);
  assert.deepEqual(g.marker(), { mode: "local", model: sha });
  // An unreadable marker is no proof of anything.
  fs.writeFileSync(g.markerFile, "{");
  assert.equal(await g.start(), "local");
  assert.equal(g.rebuilds.length, 3);
});

test("without an agent that has an index nothing is rebuilt and the marker follows", async (t) => {
  const f = fixture(t, { agents: [] });
  await f.switch(true);
  assert.deepEqual(f.rebuilds, []);
  assert.deepEqual(f.marker(), { mode: "local", model: sha });
  assert.equal(f.memory.status().state, "on");
});

test("with the agent service stopped the switch is saved and waits for the next start", async (t) => {
  const f = fixture(t);
  f.stopped = true;
  await f.switch(true);
  let status = f.memory.status();
  assert.equal(status.state, "on");
  assert.equal(status.pending, true);
  assert.deepEqual(f.rebuilds, []);
  f.stopped = false;
  assert.equal(await f.start(), "local");
  status = f.memory.status();
  assert.equal(status.pending, false);
  assert.deepEqual(f.marker(), { mode: "local", model: sha });
});

test("AgentPier's shutdown stops a download and a rebuild; the next process recovers", async (t) => {
  const f = fixture(t);
  f.download = Promise.withResolvers();
  f.memory.set({ enabled: true, revision: 1, acceptTerms: true });
  const closing = f.memory.close();
  f.download.resolve();
  await closing;
  // No failure is written at shutdown: the intent tells the next process.
  assert.deepEqual(f.state().intent, { target: "local", since: 1000 });
  assert.equal(f.state().failure, null);
  f.create();
  assert.equal(f.memory.status().failure.code, "INTERRUPTED");
  // A rebuild in flight is stopped, its journal stays, and no fallback runs.
  const g = fixture(t, { installed: true });
  writePrivate(g.stateFile, { enabled: true, revision: 2 });
  g.gate = Promise.withResolvers();
  const starting = g.start();
  await new Promise((resolve) => setImmediate(resolve));
  const closed = g.memory.close();
  g.gate.resolve();
  await Promise.all([starting, closed]);
  assert.deepEqual(g.rebuilds, [{ mode: "local", semantic: true }]);
  assert.deepEqual(g.state().journal, { target: "local", since: 1000 });
  assert.equal(
    g.calls.some((call) => call.startsWith("warn:")),
    false,
  );
  g.create();
  assert.equal(g.memory.status().failure.code, "INTERRUPTED");
});

test("every start stops an embedding server a killed Gateway left behind", async (t) => {
  const f = fixture(t);
  await f.start();
  const reclaims = () => f.calls.filter((call) => call === "reclaim").length;
  assert.equal(reclaims(), 1);
  await f.memory.retire();
  assert.equal(reclaims(), 2);
});

test("on is shown only while embeddings answer: a missing asset or a keyword answer degrades it", async (t) => {
  const f = fixture(t);
  await f.switch(true);
  assert.equal(f.memory.status().state, "on");
  assert.equal(f.memory.status().degraded, undefined);
  // The model or the server is gone while the Gateway runs: every status read sees it.
  f.have.model = false;
  let status = f.memory.status();
  assert.equal(status.state, "degraded");
  assert.equal(status.enabled, true);
  assert.deepEqual(status.degraded, { code: "EMBEDDING_MODEL_MISSING" });
  // The same value at each read: nothing to push without a change.
  assert.deepEqual(f.memory.status(), status);
  f.have.model = true;
  f.have.server = false;
  assert.deepEqual(f.memory.status().degraded, { code: "EMBEDDING_SERVER_MISSING" });
  f.have.server = true;
  assert.equal(f.memory.status().state, "on");
  // A memory search answered without embeddings (OpenClaw's own keyword fallback).
  f.views.length = 0;
  f.memory.observe({ provider: "none", results: [] });
  status = f.memory.status();
  assert.equal(status.state, "degraded");
  assert.deepEqual(status.degraded, { code: "EMBEDDINGS_UNAVAILABLE", at: 1000 });
  assert.equal(f.views.at(-1).state, "degraded", "the change is pushed");
  // A search without hits proves nothing; one with vector hits proves it works.
  f.memory.observe({ provider: "local", results: [] });
  assert.equal(f.memory.status().state, "degraded");
  f.memory.observe({ provider: "local", results: [{ path: "memory/a.md" }] });
  assert.equal(f.memory.status().state, "on");
  // Unchanged observations push nothing; answers of another runtime are ignored.
  const pushed = f.views.length;
  f.memory.observe({ provider: "local", results: [{ path: "memory/a.md" }] });
  f.memory.observe({ results: [] });
  f.memory.observe(undefined);
  assert.equal(f.views.length, pushed);
  // A new Gateway process starts without the previous one's evidence.
  f.memory.observe({ provider: "none" });
  assert.equal(await f.start(), "local");
  assert.equal(f.memory.status().state, "on");
});

test("while it is off, or keyword indexes are in place, a keyword answer is the normal one", async (t) => {
  const f = fixture(t);
  f.memory.observe({ provider: "none", results: [] });
  assert.equal(f.memory.status().state, "off");
  let asked = 0;
  await f.memory.check(async () => [++asked]);
  assert.equal(asked, 0);
  f.stopped = true;
  await f.switch(true);
  f.memory.observe({ provider: "none", results: [] });
  assert.equal(f.memory.status().pending, true);
  assert.equal(f.memory.status().state, "on");
});

test("a check asks the Gateway once per interval and never when it is already degraded", async (t) => {
  const f = fixture(t, { now: () => f.clock });
  f.clock = 1000;
  await f.switch(true);
  const asked = [];
  const probe = (answers) => async () => {
    asked.push(f.clock);
    return answers;
  };
  const healthy = [{ provider: "local", results: [] }];
  // Once per Gateway process for the owner's look at the tab.
  await f.memory.check(probe(healthy), { everyMs: Infinity });
  await f.memory.check(probe(healthy), { everyMs: Infinity });
  assert.deepEqual(asked, [1000]);
  assert.equal(f.memory.status().state, "on");
  // After an agent's own search: at most once per interval.
  f.clock += 60000;
  await f.memory.check(probe(healthy), { everyMs: 600000 });
  f.clock += 600000;
  await f.memory.check(probe([...healthy, { provider: "none", results: [] }]), {
    everyMs: 600000,
  });
  assert.deepEqual(asked, [1000, 661000]);
  assert.deepEqual(f.memory.status().degraded, {
    code: "EMBEDDINGS_UNAVAILABLE",
    at: 661000,
  });
  // Degraded already: nothing more to learn until it is repaired.
  f.clock += 6000000;
  await f.memory.check(probe(healthy), { everyMs: 0 });
  assert.equal(asked.length, 2);
  // A probe that cannot ask is no evidence; a new process may check again.
  await f.start();
  await f.memory.check(async () => {
    throw new Error("unavailable");
  });
  assert.equal(f.memory.status().state, "on");
});

test("repair installs the assets again, restarts and rebuilds; it needs no second consent", async (t) => {
  const f = fixture(t);
  await f.switch(true);
  f.memory.observe({ provider: "none", results: [] });
  f.calls.length = f.rebuilds.length = f.views.length = 0;
  const answer = f.memory.set({
    enabled: true,
    repair: true,
    revision: f.memory.status().revision,
  });
  assert.equal(answer.state, "downloading");
  await f.memory.idle();
  assert.deepEqual(
    f.calls.filter((c) => c !== "reclaim"),
    ["removeServer", "ensureServer", "ensureModel", "restart"],
  );
  // Every index is rebuilt for local embeddings and checked, whatever the marker said.
  assert.deepEqual(f.rebuilds, [{ mode: "local", semantic: true }]);
  assert.deepEqual(f.marker(), { mode: "local", model: sha });
  const status = f.memory.status();
  assert.equal(status.state, "on");
  assert.equal(status.degraded, undefined);
  assert.deepEqual(seen(f), [
    "downloading",
    "rebuilding:stopping",
    "rebuilding:indexing",
    "rebuilding:starting",
    "on",
  ]);
  // Without repair, on while on changes nothing.
  f.calls.length = 0;
  assert.equal(f.memory.set({ enabled: true, revision: status.revision }).state, "on");
  assert.deepEqual(f.calls, []);
  // Repair is no way to switch it on without the terms.
  const g = fixture(t);
  assert.throws(() => g.memory.set({ enabled: true, repair: true, revision: 1 }), {
    code: "TERMS_REQUIRED",
  });
});

test("a repair that cannot fix it ends honestly: degraded with the reason, or off after the rebuild", async (t) => {
  // The server cannot be installed again (a missing system library).
  const f = fixture(t);
  await f.switch(true);
  f.fail.server = refusal("EMBEDDING_SERVER_UNUSABLE");
  f.calls.length = 0;
  await f.switch(true, { repair: true });
  let status = f.memory.status();
  assert.equal(status.state, "degraded");
  assert.deepEqual(status.degraded, { code: "EMBEDDING_SERVER_UNUSABLE" });
  assert.equal(f.calls.includes("restart"), false);
  // The next Gateway start falls back to keyword search and rebuilds for it.
  f.rebuilds.length = 0;
  assert.equal(await f.start(), "none");
  assert.deepEqual(f.rebuilds, [{ mode: "none", semantic: false }]);
  status = f.memory.status();
  assert.equal(status.state, "failed");
  assert.equal(status.failure.code, "EMBEDDING_SERVER_MISSING");
  // The rebuild's check still fails: off with the reason, keyword indexes in place.
  const g = fixture(t);
  await g.switch(true);
  g.fail.local = refusal("MEMORY_INDEX_UNVERIFIED");
  await g.switch(true, { repair: true });
  status = g.memory.status();
  assert.equal(status.state, "failed");
  assert.equal(status.failure.code, "MEMORY_INDEX_UNVERIFIED");
  assert.deepEqual(g.marker(), { mode: "keyword", model: null });
  // A refused restart leaves it on and degraded as before.
  const h = fixture(t);
  await h.switch(true);
  h.memory.observe({ provider: "none" });
  h.fail.restart = Object.assign(Error("busy"), { status: 409, key: "active" });
  await h.switch(true, { repair: true });
  assert.equal(h.memory.status().enabled, true);
  h.fail = {};
  h.rebuilds.length = 0;
  assert.equal(await h.start(), "local");
  assert.deepEqual(h.rebuilds, [{ mode: "local", semantic: true }]);
  assert.equal(h.memory.status().state, "on");
});

test("a start hashes the model once; changed bytes go back to keyword search", async (t) => {
  const f = fixture(t);
  await f.switch(true);
  f.rebuilds.length = 0;
  f.have.verified = false;
  assert.equal(await f.start(), "none");
  assert.deepEqual(f.rebuilds, [{ mode: "none", semantic: false }]);
  const status = f.memory.status();
  assert.equal(status.state, "failed");
  assert.equal(status.failure.code, "EMBEDDING_MODEL_CHANGED");
  assert.deepEqual(f.marker(), { mode: "keyword", model: null });
});
