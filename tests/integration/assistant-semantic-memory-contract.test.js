import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import {
  embeddingPaths,
  ensureEmbeddingModel,
  ensureEmbeddingServer,
  installedEmbeddingModel,
} from "../../server/features/assistants/runtimes/openclaw/embedding-assets.js";
import {
  markerFile,
  stateFile,
} from "../../server/features/assistants/runtimes/openclaw/semantic-memory.js";
import { connectSemanticMemory } from "../../server/application/semantic-memory-wiring.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { NativeMemory } from "../../server/features/assistants/native-memory.js";
import { assistantMemoryModel } from "../helpers/assistant-memory-model.js";
import { stepPolicyBridge } from "../helpers/assistant-step-policy-bridge.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

// The owner's semantic memory search against the pinned Gateway, end to end, with the
// real plugin, the real llama.cpp server and the real embedding model: no model
// account, no embedding service, nothing leaves the machine. `installed` is the
// runtime the installer provisioned; `assets` is a data directory root (`<data>/
// assistants`) whose `embeddings/` folder keeps the pinned server and model between
// runs (CI caches it). What is missing there is downloaded once from the pinned
// URLs; each test then works on its own copy in its own data directory.
const installed = process.env.AGENTPIER_SEMANTIC_MEMORY_CONTRACT_RUNTIME;
const assets = process.env.AGENTPIER_EMBEDDING_ASSETS;
const skip = !installed || !assets;

const rss = (pid) => {
  try {
    return Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)]).toString());
  } catch {
    return null;
  }
};
// The server's router process and the model process it starts.
const serverRss = (pid) => {
  let children = [];
  try {
    children = execFileSync("pgrep", ["-P", String(pid)])
      .toString()
      .trim()
      .split("\n");
  } catch {
    /* No child yet. */
  }
  return [pid, ...children].reduce((sum, id) => sum + (rss(id) || 0), 0);
};
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function fixture(t) {
  assert.ok(path.isAbsolute(installed) && path.isAbsolute(assets));
  const app = path.join(installed, "app/node_modules");
  assert.equal(
    readJSON(path.join(app, "openclaw/package.json")).version,
    runtimeManifest.version,
  );
  // The pinned assets, from the pinned URLs unless the cache holds them.
  await ensureEmbeddingServer({ root: assets });
  await ensureEmbeddingModel({ root: assets });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "semantic-memory-contract-"));
  const descriptor = {
    version: runtimeManifest.version,
    nodePath: path.join(installed, "node/bin/node"),
    entryPath: path.join(app, "openclaw/openclaw.mjs"),
    embeddingPlugin: {
      id: runtimeManifest.embeddingPlugin.id,
      directory: path.join(app, "@openclaw/llama-cpp-provider"),
    },
  };
  const runtime = new RuntimeSupervisor({ dataDir, install: async () => descriptor });
  const store = new AssistantStore({ dataDir });
  let model, bridge, semantic;
  t.after(async () => {
    try {
      await semantic?.close();
      await runtime.close();
      await semantic?.retire();
      store.close();
      await model?.close();
      await bridge?.close();
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  model = await assistantMemoryModel();
  const plugin = provisionTeamPlugin({
    paths: runtime.paths,
    runtimeVersion: descriptor.version,
  });
  bridge = await stepPolicyBridge("semantic-fixture");
  runtime.teamConfiguration = async () => ({
    directory: plugin.directory,
    connection: bridge.connection,
    hostMaxConcurrent: 4,
    native: { token: "semantic-fixture" },
    profiles: store.listAssistants(),
  });
  runtime.beforeSpawn = async () => {};
  const models = {
    resolve: ({ modelId }) => ({
      providerId: "semantic-fixture",
      modelRef: `semantic-fixture/${modelId}`,
      provider: {
        baseUrl: model.url,
        api: "openai-completions",
        apiKey: "semantic-fixture",
        models: [
          { id: "model-a", name: "model-a", contextWindow: 32768, maxTokens: 4096 },
        ],
      },
      release() {},
    }),
  };
  const config = new AssistantConfig({
    runtime,
    store,
    models,
    workspaces: runtime.paths.workspaces,
  });
  config.nativeReady = () => true;
  // The real wiring: its switch restarts the Gateway, each start compiles and
  // reconciles. The restart stands in for the provider synchronization's.
  semantic = connectSemanticMemory({
    assistantRuntime: runtime,
    assistantProviderSynchronization: {
      async restartGateway(operation) {
        await runtime.stop();
        await operation();
        await runtime.start();
        config.client = runtime.client;
        config.reset();
      },
    },
  });
  // The switch's own asset steps find the cached files as an earlier download of
  // this installation would have left them, and check them as it always does.
  const own = embeddingPaths(runtime.paths.root);
  const cached = embeddingPaths(assets);
  const seed = ({ model: withModel = true } = {}) => {
    fs.cpSync(cached.serverDirectory, own.serverDirectory, { recursive: true });
    if (!withModel) return;
    fs.mkdirSync(own.models, { recursive: true });
    for (const suffix of ["", ".json"])
      fs.copyFileSync(cached.model + suffix, own.model + suffix);
  };
  await runtime.start();
  config.client = runtime.client;
  const assistants = {
    store,
    runtime,
    config,
    admit: (fn) => Promise.resolve().then(fn),
    requireReady: () => assert.ok(runtime.client.ready),
    changed() {},
  };
  const memory = new NativeMemory(assistants);
  async function create(name) {
    let agent = store.createAssistant({
      name,
      instructions: "Answer briefly.",
      model: { connectionId: "semantic-fixture", modelId: "model-a" },
    });
    agent = store.updateAssistant(
      agent.id,
      { capabilities: { memory: true, reminders: false } },
      agent.revision,
    );
    await config.apply(agent.id);
    return agent;
  }
  const noteFile = (agent, name) =>
    path.join(runtime.paths.workspaces, agent.id, "memory", name);
  const note = (agent, name, text) => {
    fs.mkdirSync(path.dirname(noteFile(agent, name)), { recursive: true });
    fs.writeFileSync(noteFile(agent, name), text);
  };
  const search = async (agent, query) =>
    (await memory.search(agent.id, query)).results.map((hit) => hit.path);
  // The Gateway's watcher indexes a changed note shortly after the change.
  async function eventually(agent, query, accept, message) {
    const deadline = Date.now() + contractTimeout(30000);
    let hits;
    for (;;) {
      // A search right after a change may still be refused while the index opens.
      hits = await search(agent, query).catch((error) => error);
      if (Array.isArray(hits) && accept(hits)) return hits;
      if (Date.now() > deadline)
        assert.fail(
          `${message}: ${hits instanceof Error ? hits.message : JSON.stringify(hits)}`,
        );
      await delay(250);
    }
  }
  // Switches and resolves with how long each step the owner sees took, in order.
  const switched = async (enabled) => {
    const before = semantic.status();
    const pid = runtime.child?.pid;
    const steps = [];
    const sample = () => {
      const { state, progress } = semantic.status();
      const step = progress?.phase ? `${state}:${progress.phase}` : state;
      if (steps.at(-1)?.step !== step) steps.push({ step, at: Date.now() });
    };
    const answer = semantic.set({
      enabled,
      revision: before.revision,
      acceptTerms: true,
    });
    assert.notEqual(answer.state, before.state, "the switch answers its first state");
    const timer = setInterval(sample, 20);
    sample();
    await semantic.idle().finally(() => clearInterval(timer));
    sample();
    if (runtime.client?.ready) assert.notEqual(runtime.child.pid, pid, "restarted");
    return steps
      .slice(0, -1)
      .map(({ step, at }, index) => `${step} ${steps[index + 1].at - at} ms`)
      .join(", ");
  };
  const compiled = async () => (await runtime.client.call("config.get", {})).config;
  const marker = () => readJSON(path.join(runtime.paths.state, markerFile), null);
  const serverPid = () => {
    try {
      return Number(fs.readFileSync(own.pidFile, "utf8").trim());
    } catch {
      return null;
    }
  };
  return {
    runtime,
    semantic,
    config,
    own,
    seed,
    create,
    note,
    noteFile,
    search,
    eventually,
    switched,
    compiled,
    marker,
    serverPid,
    dataDir,
  };
}

test(
  "semantic memory search finds notes by meaning, per agent, and goes back to keyword search",
  { skip, timeout: contractTimeout(600000) },
  async (t) => {
    const f = await fixture(t);
    const alpha = await f.create("Alpha semantic contract");
    const beta = await f.create("Beta semantic contract");
    f.note(
      alpha,
      "ferien.md",
      "- Die Ferien an der Ostsee waren wunderbar: zwei Wochen in Kühlungsborn.\n",
    );
    f.note(
      alpha,
      "auto.md",
      "- Der Wagen muss im März zur Inspektion in die Werkstatt.\n",
    );
    f.note(
      beta,
      "sylt.md",
      "- Beta verbringt die Sommerfrische am Strand von Sylt (BETAONLYTOKEN).\n",
    );

    // Off, the default: the compiled keyword search, which matches words only.
    let config = await f.compiled();
    assert.equal(config.memory.search.provider, "none");
    assert.equal(config.plugins.allow.includes("llama-cpp"), false);
    assert.equal(config.models?.providers?.["llama-cpp"], undefined);
    assert.deepEqual(f.semantic.status().state, "off");
    await f.eventually(
      alpha,
      "Ostsee",
      (hits) => hits.includes("memory/ferien.md"),
      "keyword hit",
    );
    await f.eventually(
      beta,
      "Sylt",
      (hits) => hits.includes("memory/sylt.md"),
      "keyword hit",
    );
    assert.deepEqual(
      await f.search(alpha, "Urlaub am Meer"),
      [],
      "no shared word, no hit",
    );

    // On: the assets are checked, the Gateway restarts and its start rebuilds both
    // agents' indexes before it spawns.
    f.seed();
    const gatewayBefore = rss(f.runtime.child.pid);
    const steps = await f.switched(true);
    assert.deepEqual(
      { ...f.semantic.status(), revision: 0, model: 0 },
      {
        available: true,
        enabled: true,
        state: "on",
        progress: null,
        failure: null,
        pending: false,
        revision: 0,
        model: 0,
      },
    );
    assert.deepEqual(f.marker(), {
      mode: "local",
      model: runtimeManifest.embeddingModel.sha256,
    });
    config = await f.compiled();
    assert.equal(config.memory.search.provider, "local");
    assert.equal(config.memory.search.fallback, "none");
    assert.equal(config.memory.search.local.modelPath, f.own.model);
    assert.ok(config.plugins.allow.includes("llama-cpp"));
    const provider = config.models.providers["llama-cpp"];
    assert.match(provider.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.equal(provider.localService.command, "/bin/sh");
    assert.ok(provider.localService.args.includes(f.own.command));

    // A German note found by a German query that shares no word with it, and by an
    // English one.
    const started = Date.now();
    assert.ok((await f.search(alpha, "Urlaub am Meer")).includes("memory/ferien.md"));
    const coldMs = Date.now() - started;
    const warm = Date.now();
    assert.equal((await f.search(alpha, "Urlaub am Meer"))[0], "memory/ferien.md");
    const warmMs = Date.now() - warm;
    assert.equal(
      (await f.search(alpha, "When is the car due for service?"))[0],
      "memory/auto.md",
    );

    // The server is the pinned build AgentPier installed, started by the Gateway.
    const pid = f.serverPid();
    assert.ok(pid && alive(pid), "the embedding server runs");
    t.diagnostic(
      `switching on: ${steps}; first query ${coldMs} ms, next ${warmMs} ms; ` +
        `Gateway RSS ${gatewayBefore} KiB before, ${rss(f.runtime.child.pid)} KiB with it; ` +
        `embedding server RSS ${serverRss(pid)} KiB (router and model process)`,
    );

    // Isolation: each agent searches its own index only.
    assert.deepEqual(await f.search(beta, "Urlaub am Meer"), ["memory/sylt.md"]);
    for (const query of ["BETAONLYTOKEN", "Sommerfrische am Strand von Sylt"])
      assert.equal(
        (await f.search(alpha, query)).some((hit) => hit.includes("sylt")),
        false,
        "another agent's note is never a hit",
      );

    // A deleted note leaves the vector index; a new one enters it, without a rebuild.
    fs.unlinkSync(f.noteFile(alpha, "ferien.md"));
    f.note(
      alpha,
      "zahnarzt.md",
      "- Der Zahnarzttermin ist am 14. Dezember um neun Uhr.\n",
    );
    await f.eventually(
      alpha,
      "Urlaub am Meer",
      (hits) => !hits.includes("memory/ferien.md"),
      "the deleted note is still a hit",
    );
    await f.eventually(
      alpha,
      "Wann muss ich zum Dentisten?",
      (hits) => hits[0] === "memory/zahnarzt.md",
      "the new note is no hit",
    );
    // An agent created while it is on searches by meaning from its first note.
    const gamma = await f.create("Gamma semantic contract");
    f.note(gamma, "boot.md", "- Das Segelboot liegt im Hafen von Kiel.\n");
    await f.eventually(
      gamma,
      "Wo ist mein Schiff?",
      (hits) => hits.includes("memory/boot.md"),
      "a new agent's note is no hit",
    );

    // A restart changes the server's port; the indexes stay valid.
    await f.runtime.stop();
    await f.runtime.start();
    f.config.client = f.runtime.client;
    assert.equal(f.semantic.status().state, "on");
    assert.equal(
      (await f.search(alpha, "Wann muss ich zum Dentisten?"))[0],
      "memory/zahnarzt.md",
    );
    const last = f.serverPid();
    assert.ok(last && alive(last), "the restarted Gateway started its own server");

    // Off again: keyword search works at once, the model is removed and no
    // embedding server is left.
    t.diagnostic(`switching off: ${await f.switched(false)}`);
    assert.equal(f.semantic.status().state, "off");
    assert.deepEqual(f.marker(), { mode: "keyword", model: null });
    config = await f.compiled();
    assert.equal(config.memory.search.provider, "none");
    assert.equal(config.memory.search.local, undefined);
    assert.equal(config.plugins.allow.includes("llama-cpp"), false);
    assert.equal(config.models?.providers?.["llama-cpp"], undefined);
    await f.eventually(
      alpha,
      "Inspektion",
      (hits) => hits.includes("memory/auto.md"),
      "keyword hit",
    );
    await f.eventually(
      alpha,
      "Zahnarzttermin",
      (hits) => hits.includes("memory/zahnarzt.md"),
      "keyword hit",
    );
    assert.deepEqual(await f.search(alpha, "When is the car due for service?"), []);
    assert.deepEqual(await f.search(alpha, "BETAONLYTOKEN"), []);
    assert.equal(
      installedEmbeddingModel(f.runtime.paths.root),
      null,
      "the model is removed",
    );
    for (const server of [pid, last])
      assert.equal(alive(server), false, "the embedding server ended");
  },
);

test(
  "a failed or interrupted index rebuild leaves keyword search working and the switch off",
  { skip, timeout: contractTimeout(600000) },
  async (t) => {
    const f = await fixture(t);
    const alpha = await f.create("Alpha fallback contract");
    f.note(
      alpha,
      "auto.md",
      "- Der Wagen muss im März zur Inspektion in die Werkstatt.\n",
    );
    await f.eventually(
      alpha,
      "Inspektion",
      (hits) => hits.includes("memory/auto.md"),
      "keyword hit",
    );

    // A model file the server cannot load (its receipt and size are right, so the
    // start compiles local embeddings): the rebuild fails, the setting goes off with
    // the reason and the same start rebuilds the keyword index.
    f.seed();
    const { size } = fs.statSync(f.own.model);
    fs.writeFileSync(f.own.model, Buffer.alloc(size, 7));
    const verifyModel = f.semantic.assets.verifyModel;
    f.semantic.assets.verifyModel = async () => true;
    await f.switched(true);
    let status = f.semantic.status();
    assert.equal(status.state, "failed");
    assert.equal(status.enabled, false);
    assert.equal(status.failure.code, "MEMORY_INDEX_FAILED");
    assert.deepEqual(f.marker(), { mode: "keyword", model: null });
    assert.equal((await f.compiled()).memory.search.provider, "none");
    await f.eventually(
      alpha,
      "Inspektion",
      (hits) => hits.includes("memory/auto.md"),
      "keyword hit",
    );

    // On for real; then AgentPier "dies" in the middle of a later rebuild for local
    // embeddings: its journal is all that is left. The next AgentPier process
    // switches the setting off as interrupted, and the next Gateway start rebuilds
    // the keyword index.
    f.semantic.assets.verifyModel = verifyModel;
    f.seed();
    await f.switched(true);
    assert.equal(f.semantic.status().state, "on");
    assert.equal(
      (await f.search(alpha, "When is the car due for service?"))[0],
      "memory/auto.md",
    );
    await f.runtime.stop();
    const file = path.join(f.runtime.paths.root, stateFile);
    writePrivate(file, {
      ...readJSON(file),
      intent: { target: "local", since: 1 },
      journal: { target: "local", since: 1 },
    });
    f.semantic.recover();
    status = f.semantic.status();
    assert.equal(status.enabled, false);
    assert.equal(status.failure.code, "INTERRUPTED");
    await f.runtime.start();
    f.config.client = f.runtime.client;
    assert.equal(f.semantic.status().state, "failed");
    assert.deepEqual(f.marker(), { mode: "keyword", model: null });
    assert.equal(readJSON(file).journal, null);
    await f.eventually(
      alpha,
      "Inspektion",
      (hits) => hits.includes("memory/auto.md"),
      "keyword hit",
    );
    assert.deepEqual(await f.search(alpha, "When is the car due for service?"), []);
  },
);
