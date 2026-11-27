import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskControl, taskStopError } from "../../server/features/chat/task-control.js";
import { TaskStopStore } from "../../server/features/chat/task-stop-store.js";

const session = { id: "s1", tool: "claude", status: "running" };
const NOTE = (name, id) =>
  `[AgentPier: the user stopped background task "${name}" (${id}).]`;

function snapshot(extra = {}) {
  const agent = (id, name, status = "running") => ({ id, name, status });
  return {
    observability: {
      stale: false,
      subagents: [
        agent("agent1", "reviewer"),
        agent("agent2", "builder"),
        agent("agent3", "tester"),
        agent("done1", "finished", "completed"),
      ],
      shells: [{ id: "sh1", command: 'sleep 100 "x"\u0007', status: "running" }],
      ...extra,
    },
  };
}

// Without `timeoutMs` a stop has the product's ten seconds: only the tests about a late
// answer set a short one, so a busy machine never times out a stop that answers.
function setup(t, { timeoutMs, current = session, snap = snapshot() } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-control-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const stops = new TaskStopStore({ dataDir });
  const driver = {
    calls: [],
    down: false,
    hang: false,
    result: { ok: true },
    connected: () => !driver.down,
    canStop: () => true,
    stop: async (_session, task) => {
      driver.calls.push(task);
      if (driver.hang) return new Promise(() => {});
      await new Promise((resolve) => setImmediate(resolve));
      return driver.result;
    },
  };
  const changes = [];
  const reads = {
    flags: (_session, kind) =>
      kind === "shell" ? { hasOutput: true } : { hasTranscript: true },
  };
  const holder = {};
  const chat = { read: async () => holder.control.overlay(current, snap) };
  const control = new TaskControl({
    sessions: { get: async () => current },
    chat,
    reads,
    stops,
    onChange: (id) => changes.push(id),
    timeoutMs,
  });
  holder.control = control;
  control.register("claude", driver);
  return { control, driver, stops, changes, dataDir, snap };
}

test("two stops of one task share one driver call and leave one note", async (t) => {
  const { control, driver, changes, snap } = setup(t);
  const [a, b] = await Promise.all([
    control.stop("s1", "agent1"),
    control.stop("s1", "agent1"),
  ]);
  assert.deepEqual(
    [a, b, driver.calls.length],
    [{ stopped: true }, { stopped: true }, 1],
  );
  assert.deepEqual(driver.calls[0].kind, "agent");
  assert.deepEqual(
    control.overlay(session, snap).observability.stopNotes.map((n) => n.text),
    [NOTE("reviewer", "agent1")],
  );
  assert.deepEqual(changes, ["s1"]);
  const entry = control
    .overlay(session, snap)
    .observability.subagents.find((item) => item.id === "agent1");
  assert.deepEqual([entry.status, entry.canStop], ["stopped", false]);
});

test("a finished, unknown or unsupported task cannot be stopped", async (t) => {
  const { control } = setup(t);
  await assert.rejects(control.stop("s1", "done1"), {
    code: "TASK_STOP_NOT_RUNNING",
    status: 409,
  });
  await assert.rejects(control.stop("s1", "nope"), { status: 404 });
  control.drivers.clear();
  await assert.rejects(control.stop("s1", "agent1"), {
    code: "TASK_STOP_UNSUPPORTED",
    status: 409,
  });
});

test("a driver that does not answer times out and records nothing", async (t) => {
  const { control, driver, stops, changes } = setup(t, { timeoutMs: 20 });
  driver.hang = true;
  await assert.rejects(control.stop("s1", "agent2"), {
    code: "TASK_STOP_TIMEOUT",
    status: 504,
  });
  assert.equal(stops.has(session, "agent2"), false);
  assert.deepEqual(changes, []);
});

test("a down channel, a refusal and a vanished task each have their own error", async (t) => {
  const { control, driver, stops } = setup(t);
  driver.down = true;
  await assert.rejects(control.stop("s1", "agent2"), {
    code: "TASK_STOP_CHANNEL_DOWN",
    status: 503,
  });
  assert.equal(driver.calls.length, 0);
  driver.down = false;
  driver.result = { ok: false, reason: "No permission" };
  await assert.rejects(control.stop("s1", "agent3"), {
    code: "TASK_STOP_REFUSED",
    reason: "No permission",
    status: 409,
  });
  driver.result = { ok: false, reason: "No task found", gone: true };
  await assert.rejects(control.stop("s1", "agent3"), { code: "TASK_STOP_NOT_RUNNING" });
  // Not stopped: only marked as ended (task-control-marks.test.js).
  assert.equal(stops.get(session, "agent3").ended, true);
});

test("a driver that cannot stop this task is unsupported", async (t) => {
  const { control, driver } = setup(t);
  driver.canStop = () => false;
  await assert.rejects(control.stop("s1", "agent1"), { code: "TASK_STOP_UNSUPPORTED" });
});

test("a stopped shell survives a new store and its note names the cleaned command", async (t) => {
  const { control, stops, dataDir, snap } = setup(t);
  await control.stop("s1", "sh1");
  assert.equal(stops.has(session, "sh1"), true);
  const again = new TaskControl({
    sessions: {},
    chat: {},
    reads: { flags: () => ({ hasOutput: true }) },
    stops: new TaskStopStore({ dataDir }),
    onChange: () => {},
  });
  again.register("claude", { connected: () => true, canStop: () => true });
  const shell = again.overlay(session, snap).observability.shells[0];
  assert.deepEqual(
    [shell.status, shell.canStop, shell.hasOutput],
    ["stopped", false, true],
  );
  const [note] = control.overlay(session, snap).observability.stopNotes;
  assert.equal(note.text, NOTE("sleep 100 'x' ", "sh1"));
  assert.match(note.id, /^[0-9a-f-]{36}$/);
});

test("completed and failed entries keep their status even when once stopped", (t) => {
  const { control, stops } = setup(t);
  stops.record(session, { id: "done1", kind: "agent", at: 1 });
  const done = control
    .overlay(session, snapshot())
    .observability.subagents.find((item) => item.id === "done1");
  assert.equal(done.status, "completed");
});

test("a stale or not running session offers no stop", (t) => {
  const { control } = setup(t);
  const flags = (current, snap) =>
    [
      ...control.overlay(current, snap).observability.subagents,
      ...control.overlay(current, snap).observability.shells,
    ].map((entry) => entry.canStop);
  assert.ok(flags(session, snapshot()).includes(true));
  assert.ok(!flags(session, snapshot({ stale: true })).includes(true));
  assert.ok(!flags({ ...session, status: "stopped" }, snapshot()).includes(true));
  const disconnected = new TaskControl({
    sessions: {},
    chat: {},
    reads: { flags: () => ({}) },
    stops: new TaskStopStore({ dataDir: os.tmpdir() }),
    onChange: () => {},
  });
  assert.ok(!disconnected.overlay(session, snapshot()).observability.shells[0].canStop);
});

test("notes are carried by their text, consumed once and capped", async (t) => {
  const { control, snap } = setup(t);
  await control.stop("s1", "agent1");
  await control.stop("s1", "agent2");
  const [first, second] = control.overlay(session, snap).observability.stopNotes;
  const text = `hello\n${first.text}`;
  assert.deepEqual(control.notesCarried("s1", [first.id, second.id, "x"], text), [
    first.id,
  ]);
  control.consumeNotes("s1", [first.id]);
  control.consumeNotes("s1", [first.id]);
  assert.deepEqual(
    control.overlay(session, snap).observability.stopNotes.map((n) => n.id),
    [second.id],
  );
  for (let index = 0; index < 25; index += 1) control.addNote("s1", `note ${index}`);
  assert.equal(control.overlay(session, snap).observability.stopNotes.length, 20);
});

test("a snapshot without observability passes through", (t) => {
  const { control } = setup(t);
  const bare = { availability: "unbound", messages: [] };
  assert.deepEqual(control.overlay(session, bare), bare);
});

test("a throwing driver or reads.flags never breaks the overlay", (t) => {
  const { control, driver } = setup(t);
  const entries = () => {
    const observability = control.overlay(session, snapshot()).observability;
    return [...observability.subagents, ...observability.shells];
  };
  driver.connected = () => {
    throw new Error("down");
  };
  assert.ok(entries().every((entry) => entry.canStop === false));
  driver.connected = () => true;
  driver.canStop = () => {
    throw new Error("boom");
  };
  assert.ok(entries().every((entry) => entry.canStop === false));
  driver.canStop = () => true;
  control.reads = {
    flags: () => {
      throw new Error("flags");
    },
  };
  const all = entries();
  assert.ok(
    all.every((entry) => entry.hasTranscript !== true && entry.hasOutput !== true),
  );
  assert.ok(all.some((entry) => entry.canStop === true));
});

test("a driver exception never reaches the browser", async (t) => {
  const { control, driver } = setup(t);
  const logged = t.mock.method(console, "error", () => {});
  driver.stop = async () => {
    throw new Error("/private/socket/path leaked");
  };
  await assert.rejects(control.stop("s1", "agent1"), (error) => {
    assert.equal(error.code, "TASK_STOP_REFUSED");
    assert.ok(!JSON.stringify([error.reason, error.message]).includes("/private"));
    return true;
  });
  assert.equal(logged.mock.callCount(), 1);
});

test("a driver's own stop error (its channel went away) reaches the route as it is", async (t) => {
  const { control, driver, changes } = setup(t);
  const logged = t.mock.method(console, "error", () => {});
  driver.stop = async () => Promise.reject(taskStopError.channelDown());
  await assert.rejects(control.stop("s1", "agent1"), {
    code: "TASK_STOP_CHANNEL_DOWN",
    status: 503,
  });
  assert.equal(logged.mock.callCount(), 0);
  assert.deepEqual(changes, [], "nothing recorded");
});

test("a stop that read the snapshot before the first one finished does not run again", async (t) => {
  const { control, driver, stops, changes } = setup(t);
  const before = snapshot();
  control.chat = { read: async () => before };
  assert.deepEqual(await control.stop("s1", "agent1"), { stopped: true });
  await assert.rejects(control.stop("s1", "agent1"), { code: "TASK_STOP_NOT_RUNNING" });
  assert.equal(driver.calls.length, 1);
  assert.equal(stops.has(session, "agent1"), true);
  assert.equal(control.overlay(session, before).observability.stopNotes.length, 1);
  assert.deepEqual(changes, ["s1"]);
});

test("a stale snapshot is answered as a down channel", async (t) => {
  const { control, driver } = setup(t, { snap: snapshot({ stale: true }) });
  await assert.rejects(control.stop("s1", "agent1"), {
    code: "TASK_STOP_CHANNEL_DOWN",
    status: 503,
  });
  assert.equal(driver.calls.length, 0);
});

test("a stop that succeeds after the timeout is still recorded", async (t) => {
  const { control, driver, stops, changes, snap } = setup(t, { timeoutMs: 20 });
  driver.stop = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { ok: true };
  };
  await assert.rejects(control.stop("s1", "agent2"), { code: "TASK_STOP_TIMEOUT" });
  assert.equal(stops.has(session, "agent2"), false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(stops.has(session, "agent2"), true);
  assert.equal(control.overlay(session, snap).observability.stopNotes.length, 1);
  assert.deepEqual(changes, ["s1"]);
});

test("a stop that fails after the timeout changes nothing", async (t) => {
  const { control, driver, stops, changes } = setup(t, { timeoutMs: 20 });
  driver.stop = async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
    return { ok: false, reason: "late" };
  };
  await assert.rejects(control.stop("s1", "agent2"), { code: "TASK_STOP_TIMEOUT" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(stops.has(session, "agent2"), false);
  assert.deepEqual(changes, []);
});

test("forget drops the stops and the notes of a discarded session", async (t) => {
  const { control, stops, snap } = setup(t);
  await control.stop("s1", "agent1");
  control.forget("s1");
  assert.equal(stops.has(session, "agent1"), false);
  assert.deepEqual(control.overlay(session, snap).observability.stopNotes, []);
});
