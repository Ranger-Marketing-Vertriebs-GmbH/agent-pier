import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OfflineCommands,
  offlineOnly,
  queueName,
  stateOwned,
} from "../../server/features/assistants/runtimes/openclaw/offline-commands.js";

// A RuntimeSupervisor stand-in: a running Gateway child until stopped.
function supervisor(
  t,
  { version = "2026.11.3", running = true, startFails = false } = {},
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "offline-commands-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const events = [];
  const s = {
    paths: { root },
    runtime: { version },
    child: running ? { exitCode: null } : null,
    states: [],
    closed: false,
    async stop() {
      events.push("stop");
      s.child = null;
    },
    async start(options) {
      events.push(["start", options]);
      if (startFails) throw Object.assign(new Error("exited"), { code: "PROCESS_EXIT" });
      s.child = { exitCode: null };
    },
    setState(patch) {
      s.states.push(patch);
    },
  };
  return { s, events, root };
}

function commands(t, options = {}) {
  const { s, events, root } = supervisor(t, options);
  const forgets = [];
  const requests = [];
  const warnings = [];
  const queue = new OfflineCommands({
    supervisor: s,
    forget: async (entry) => {
      events.push(["forget", entry.agent, [...entry.sessions]]);
      if (s.child && offlineOnly(s.runtime.version))
        throw Object.assign(new Error("owned"), { stateOwned: true });
      if (options.forget) return options.forget(entry);
      forgets.push(entry);
    },
    request: (reason) => {
      requests.push(reason);
      return options.request ?? true;
    },
    busy: () => !!options.busy,
    debounceMs: options.debounceMs ?? 10,
    retryMs: options.retryMs ?? 60000,
    ownershipWaitMs: [1, 1],
    warn: (...args) => warnings.push(args.join(" ")),
  });
  t.after(() => queue.close());
  return { queue, s, events, root, forgets, requests, warnings };
}

const file = (root) => path.join(root, queueName);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("the guard exists from OpenClaw 2026.10.10 on; an unknown runtime counts as guarded", () => {
  assert.equal(offlineOnly("2026.10.9"), false);
  assert.equal(offlineOnly("2026.9.8"), false);
  assert.equal(offlineOnly("2026.10.10"), true);
  assert.equal(offlineOnly("2026.11.3"), true);
  assert.equal(offlineOnly("2027.1.1-beta.1"), true);
  assert.equal(offlineOnly(undefined), true);
  assert.equal(
    stateOwned("Reason: This operation requires exclusive offline state ownership"),
    true,
  );
  assert.equal(stateOwned("Reason: something else"), false);
});

test("a forget beside a guarded Gateway is queued durably and asks for one restart", async (t) => {
  const f = commands(t);
  await f.queue.forget("orchid", ["s-1"]);
  await f.queue.forget("orchid", ["s-2", "s-1"]);
  await f.queue.forget("fern", ["s-3"]);
  assert.deepEqual(f.events, [], "nothing runs beside the Gateway");
  assert.deepEqual(JSON.parse(fs.readFileSync(file(f.root), "utf8")).forgets, [
    { agent: "orchid", sessions: ["s-1", "s-2"], attempts: 0 },
    { agent: "fern", sessions: ["s-3"], attempts: 0 },
  ]);
  await sleep(40);
  assert.deepEqual(f.requests, ["memoryForget"], "one debounced request");
  // The restart's start drains everything in one go, one command per agent.
  await f.s.stop();
  await f.queue.drain();
  assert.deepEqual(f.events.slice(1), [
    ["forget", "orchid", ["s-1", "s-2"]],
    ["forget", "fern", ["s-3"]],
  ]);
  assert.equal(fs.existsSync(file(f.root)), false);
  assert.deepEqual(f.s.states, [
    { maintenanceWindow: true },
    { maintenanceWindow: false },
  ]);
});

test("a forget pending at shutdown runs at the next start", async (t) => {
  const f = commands(t);
  await f.queue.forget("orchid", ["s-1"]);
  await f.queue.close();
  assert.ok(fs.existsSync(file(f.root)));
  // AgentPier starts again: a new queue over the same data, before the Gateway spawns.
  f.s.child = null;
  const forgets = [];
  const next = new OfflineCommands({
    supervisor: f.s,
    forget: async (entry) => forgets.push(entry),
  });
  t.after(() => next.close());
  await next.drain();
  assert.deepEqual(forgets, [{ agent: "orchid", sessions: ["s-1"] }]);
  assert.equal(fs.existsSync(file(f.root)), false);
});

test("without a pending restart the debounced forget opens a window of its own", async (t) => {
  const f = commands(t, { request: false });
  await f.queue.forget("orchid", ["s-1"]);
  await f.queue.flush();
  assert.deepEqual(f.events, [
    "stop",
    ["forget", "orchid", ["s-1"]],
    ["start", { automatic: true }],
  ]);
  assert.equal(fs.existsSync(file(f.root)), false);
  assert.deepEqual(f.s.states.at(-1), { maintenanceWindow: false });
});

test("an older runtime or a stopped Gateway runs the forget at once", async (t) => {
  const old = commands(t, { version: "2026.10.9" });
  // 2026.10.9 has no guard: the command runs beside the Gateway, as before.
  await old.queue.forget("orchid", ["s-1"]);
  assert.deepEqual(old.events, [["forget", "orchid", ["s-1"]]], "no stop");
  assert.equal(fs.existsSync(file(old.root)), false);
  const stopped = commands(t, { running: false });
  await stopped.queue.forget("orchid", ["s-1"]);
  assert.deepEqual(stopped.events, [["forget", "orchid", ["s-1"]]]);
  assert.deepEqual(stopped.requests, []);
  assert.equal(fs.existsSync(file(stopped.root)), false);
});

test("an owner's command runs in a window with the queued forgets, then the Gateway starts", async (t) => {
  const f = commands(t);
  await f.queue.forget("orchid", ["s-1"]);
  const result = await f.queue.run(async () => {
    f.events.push("login");
    return "url";
  });
  assert.equal(result, "url");
  await f.queue.idle();
  assert.deepEqual(f.events, [
    "stop",
    "login",
    ["forget", "orchid", ["s-1"]],
    ["start", { automatic: true }],
  ]);
  assert.deepEqual(f.s.states, [
    { maintenanceWindow: true },
    { maintenanceWindow: false },
  ]);
  // The debounced request finds nothing left.
  await sleep(40);
  assert.deepEqual(f.requests, []);
});

test("an older runtime runs an owner's command directly", async (t) => {
  const f = commands(t, { version: "2026.10.9" });
  assert.equal(await f.queue.run(async () => "direct"), "direct");
  assert.deepEqual(f.events, []);
});

test("a window refuses while maintenance or a restart runs", async (t) => {
  const f = commands(t, { busy: true });
  await assert.rejects(
    f.queue.run(async () => "never"),
    (error) => error.code === "RUNTIME_BUSY",
  );
  assert.deepEqual(f.events, []);
});

test("a command waits while OpenClaw still sees the stopped Gateway's ownership", async (t) => {
  const f = commands(t, { running: false });
  let tries = 0;
  const value = await f.queue.run(async () => {
    if (++tries < 3) throw Object.assign(new Error("owned"), { stateOwned: true });
    return "done";
  });
  assert.equal(value, "done");
  assert.equal(tries, 3);
  await assert.rejects(
    f.queue.run(async () => {
      throw Object.assign(new Error("owned"), { stateOwned: true });
    }),
    /owned/,
  );
});

test("a failed command stays queued, and a Gateway that does not come back is the supervisor's", async (t) => {
  const f = commands(t, {
    startFails: true,
    retryMs: 5,
    forget: () => {
      throw Object.assign(new Error("locked"), { code: "ETIMEDOUT" });
    },
  });
  await f.queue.forget("orchid", ["s-1"]);
  await assert.rejects(
    f.queue.run(async () => {
      throw new Error("login failed");
    }),
    /login failed/,
  );
  await f.queue.idle();
  // The start was handed to the supervisor (automatic: its own backoff restarts).
  assert.deepEqual(f.events.at(-1), ["start", { automatic: true }]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file(f.root), "utf8")).forgets, [
    { agent: "orchid", sessions: ["s-1"], attempts: 1 },
  ]);
  assert.match(f.warnings[0], /could not remove a deleted chat from dreaming: ETIMEDOUT/);
  assert.deepEqual(f.s.states.at(-1), { maintenanceWindow: false });
  // Without a Gateway, the retries run directly until the attempts are spent.
  await sleep(100);
  const attempts = JSON.parse(fs.readFileSync(file(f.root), "utf8")).forgets[0].attempts;
  assert.equal(attempts, 3);
});
