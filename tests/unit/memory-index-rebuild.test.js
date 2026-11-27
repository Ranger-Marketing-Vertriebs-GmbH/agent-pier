import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  indexedAgents,
  rebuildMemoryIndex,
} from "../../server/features/assistants/runtimes/openclaw/memory-index.js";
import { reclaimEmbeddingServer } from "../../server/features/assistants/runtimes/openclaw/embedding-server.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

// The offline `openclaw memory index --force` (memory-index.js) with the command
// replaced: what it is started with, how its output becomes progress, and how its
// ends are told apart.
const runtime = {
  nodePath: "/runtime/node/bin/node",
  entryPath: "/runtime/openclaw.mjs",
};
const config = () => ({
  agents: {
    entries: {
      main: {},
      "ap-a1": { memory: { search: { enabled: true } } },
      "ap-a2": { memory: { search: { enabled: false } } },
    },
  },
  memory: { search: { provider: "local" } },
});
const valid = (agentId, patch = {}) => ({
  agentId,
  status: { provider: "local", custom: { indexIdentity: { status: "valid" } } },
  embeddingProbe: { ok: true },
  ...patch,
});

function fixture(t, script) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-index-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  writePrivate(paths.config, config());
  const spawned = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = (signal) => {
      child.killed = signal;
      setImmediate(() => child.emit("close", null));
    };
    // The file the command reads while it runs.
    spawned.push({ command, args, options, config: readJSON(paths.config), child });
    setImmediate(() => script(child, spawned.length, args));
    return child;
  };
  const progress = [];
  const run = (options = {}) =>
    rebuildMemoryIndex({
      runtime,
      paths,
      spawn,
      onProgress: (step) => progress.push(step),
      ownershipWaitMs: [1, 1],
      ...options,
    });
  return { paths, spawned, progress, run };
}
const finish = (child, { stdout = "", stderr = "", code = 0 }) => {
  if (stdout) child.stdout.emit("data", Buffer.from(stdout));
  if (stderr) child.stderr.emit("data", Buffer.from(stderr));
  child.emit("close", code);
};

test("one offline command rebuilds every managed agent and reports each", async (t) => {
  const f = fixture(t, (child) => {
    child.stdout.emit(
      "data",
      "Memory search disabled.\nMemory Index (ap-a1)\nMemory index upd",
    );
    child.stdout.emit("data", "ated (ap-a1): 3 files indexed.\n");
    finish(child, { stdout: "Memory index updated (ap-a2): 0 files indexed.\n" });
  });
  const original = fs.readFileSync(f.paths.config, "utf8");
  assert.deepEqual(await f.run(), {
    agents: 2,
    output: [
      "Memory search disabled.",
      "Memory Index (ap-a1)",
      "Memory index updated (ap-a1): 3 files indexed.",
      "Memory index updated (ap-a2): 0 files indexed.",
      "",
    ].join("\n"),
  });
  assert.equal(f.spawned.length, 1);
  const [{ command, args, options, config: seen }] = f.spawned;
  assert.equal(command, runtime.nodePath);
  assert.deepEqual(args, [runtime.entryPath, "memory", "index", "--force"]);
  assert.equal(options.cwd, f.paths.root);
  assert.equal(options.env.OPENCLAW_CONFIG_PATH, f.paths.config);
  assert.equal(options.env.OPENCLAW_STATE_DIR, f.paths.state);
  // While it ran, every managed agent's memory was on, so none was skipped.
  assert.deepEqual(indexedAgents(seen), ["ap-a1", "ap-a2"]);
  assert.equal(seen.agents.entries["ap-a2"].memory.search.enabled, true);
  assert.equal(seen.agents.entries.main.memory, undefined);
  // Afterwards the start's own file is back, byte for byte.
  assert.equal(fs.readFileSync(f.paths.config, "utf8"), original);
  assert.deepEqual(f.progress, [
    { done: 0, total: 2 },
    { done: 1, total: 2 },
    { done: 2, total: 2 },
  ]);
});

test("a failed command, a stop and a stall are told apart; the file is restored", async (t) => {
  const failed = fixture(t, (child) =>
    finish(child, { stdout: "Memory index failed (ap-a1): no\n", code: 1 }),
  );
  const original = fs.readFileSync(failed.paths.config, "utf8");
  await assert.rejects(failed.run(), { code: "MEMORY_INDEX_FAILED" });
  assert.equal(fs.readFileSync(failed.paths.config, "utf8"), original);
  const unstartable = fixture(t, (child) => child.emit("error", new Error("ENOENT")));
  const rejected = unstartable.run();
  setImmediate(() => unstartable.spawned[0].child.emit("close", null));
  await assert.rejects(rejected, { code: "MEMORY_INDEX_FAILED" });
  // A stop (AgentPier's shutdown) ends the command with SIGTERM.
  const controller = new AbortController();
  const stopped = fixture(t, () => controller.abort());
  await assert.rejects(stopped.run({ signal: controller.signal }), {
    code: "MEMORY_INDEX_STOPPED",
  });
  assert.equal(stopped.spawned[0].child.killed, "SIGTERM");
  assert.equal(fs.readFileSync(stopped.paths.config, "utf8"), original);
  controller.abort();
  await assert.rejects(fixture(t, () => {}).run({ signal: controller.signal }), {
    code: "MEMORY_INDEX_STOPPED",
  });
  // No agent finished for too long.
  const stalled = fixture(t, () => {});
  await assert.rejects(stalled.run({ idleMs: 10 }), { code: "MEMORY_INDEX_TIMEOUT" });
  assert.equal(stalled.spawned[0].child.killed, "SIGTERM");
});

test("a state lock the stopped Gateway still releases is waited out", async (t) => {
  const owned =
    "Cannot admit memory.cli for memory stores in state root /x: This operation requires exclusive offline state ownership.";
  const f = fixture(t, (child, attempt) =>
    attempt < 3
      ? finish(child, { stderr: owned, code: 1 })
      : finish(child, { stdout: "Memory index updated (ap-a1): 1 files indexed.\n" }),
  );
  assert.equal((await f.run()).agents, 1);
  assert.equal(f.spawned.length, 3);
  // Only so often: then it is a failure like any other.
  const never = fixture(t, (child) => finish(child, { stderr: owned, code: 1 }));
  await assert.rejects(never.run(), { code: "MEMORY_INDEX_FAILED" });
  assert.equal(never.spawned.length, 3);
});

test("a rebuild for local embeddings is checked agent by agent", async (t) => {
  const report = (agents) => (child, _attempt, args) =>
    args.includes("index")
      ? finish(child, { stdout: "Memory index updated (ap-a1): 1 files indexed.\n" })
      : finish(child, { stdout: `${JSON.stringify(agents, null, 2)}\n` });
  const good = fixture(t, report([valid("ap-a1"), valid("ap-a2")]));
  await good.run({ semantic: true });
  assert.deepEqual(
    good.spawned.map(({ args }) => args.slice(1)),
    [
      ["memory", "index", "--force"],
      ["memory", "status", "--deep", "--json"],
    ],
  );
  // The check reads the same file: every managed agent with memory on.
  assert.equal(
    good.spawned[1].config.agents.entries["ap-a2"].memory.search.enabled,
    true,
  );
  // Keyword search needs no such check.
  const keyword = fixture(t, report([]));
  await keyword.run();
  assert.equal(keyword.spawned.length, 1);
  // OpenClaw indexed by keyword alone and still reported success: an agent whose
  // embedding probe fails, whose index is another provider's, or whose index
  // identity is not valid; no agent at all, and no report.
  for (const agents of [
    [valid("ap-a1"), valid("ap-a2", { embeddingProbe: { ok: false, error: "x" } })],
    [valid("ap-a1", { status: { provider: "none" } })],
    [
      valid("ap-a1", {
        status: { provider: "local", custom: { indexIdentity: { status: "mismatch" } } },
      }),
    ],
    [],
    "no report",
  ]) {
    const f = fixture(t, report(agents));
    const original = fs.readFileSync(f.paths.config, "utf8");
    await assert.rejects(f.run({ semantic: true }), { code: "MEMORY_INDEX_UNVERIFIED" });
    assert.equal(fs.readFileSync(f.paths.config, "utf8"), original);
  }
  // A status command that fails is a failed rebuild.
  const broken = fixture(t, (child, _attempt, args) =>
    args.includes("index")
      ? finish(child, { stdout: "Memory index updated (ap-a1): 1 files indexed.\n" })
      : finish(child, { code: 1 }),
  );
  await assert.rejects(broken.run({ semantic: true }), { code: "MEMORY_INDEX_FAILED" });
});

test("an embedding server left behind is stopped only when it is that server", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "embedding-server-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const pidFile = path.join(directory, "llama-server.pid");
  const command = path.join(directory, "llama-server");
  fs.writeFileSync(command, "#!");
  const real = fs.realpathSync(command);
  // No pid file, a pid that is gone, and a pid of another program: nothing is
  // signalled; the pid file is removed.
  assert.equal(await reclaimEmbeddingServer({ pidFile, command }), false);
  for (const [pid, identity] of [
    ["999999999", () => assert.fail("a dead pid is not inspected")],
    [String(process.pid), () => ({ executable: process.execPath })],
    [
      String(process.pid),
      () => {
        throw new Error("unreadable");
      },
    ],
    ["not a pid", () => assert.fail()],
    ["1", () => assert.fail()],
  ]) {
    fs.writeFileSync(pidFile, `${pid}\n`);
    assert.equal(
      await reclaimEmbeddingServer({ pidFile, command }, { identity, graceMs: 20 }),
      false,
      pid,
    );
    assert.equal(fs.existsSync(pidFile), false);
  }
  // Its own server: a process running the server executable is stopped.
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  await new Promise((resolve) => child.once("spawn", resolve));
  fs.writeFileSync(pidFile, `${child.pid}\n`);
  const exited = new Promise((resolve) =>
    child.once("exit", (_code, signal) => resolve(signal)),
  );
  assert.equal(
    await reclaimEmbeddingServer(
      { pidFile, command },
      { identity: () => ({ executable: real }), graceMs: 2000 },
    ),
    true,
  );
  assert.equal(await exited, "SIGTERM");
  assert.equal(fs.existsSync(pidFile), false);
});
