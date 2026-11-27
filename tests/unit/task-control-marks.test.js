import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TaskControl } from "../../server/features/chat/task-control.js";
import { TaskStopStore } from "../../server/features/chat/task-stop-store.js";

// The marks TaskControl keeps beside the native records: a stop, and an "ended" mark
// for a task a stop found already gone. A later run of the same id in the native
// record (a resumed agent) wins over either and removes the mark.
const session = { id: "s1", tool: "claude", status: "running" };
const iso = (ms) => new Date(ms).toISOString();

function setup(t, entries = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "task-marks-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const stops = new TaskStopStore({ dataDir });
  const snap = {
    observability: {
      stale: false,
      subagents: entries.subagents || [
        {
          id: "agent1",
          name: "general-purpose",
          task: "Review the diff",
          status: "running",
        },
      ],
      shells: entries.shells || [
        { id: "sh1", command: "sleep 100", description: "", status: "running" },
      ],
    },
  };
  const driver = {
    calls: [],
    result: { ok: true },
    connected: () => true,
    canStop: () => true,
    stop: async (_session, task) => {
      driver.calls.push(task);
      return driver.result;
    },
  };
  const changes = [];
  const control = new TaskControl({
    sessions: { get: async () => session },
    chat: { read: async () => control.overlay(session, snap) },
    reads: { flags: () => ({}) },
    stops,
    onChange: (id) => changes.push(id),
  });
  control.register("claude", driver);
  const entry = (id, current = snap) => {
    const observability = control.overlay(session, current).observability;
    return [...observability.subagents, ...observability.shells].find(
      (item) => item.id === id,
    );
  };
  return { control, driver, stops, changes, snap, entry, dataDir };
}

const withAgent = (snap, values) => ({
  observability: {
    ...snap.observability,
    subagents: [{ ...snap.observability.subagents[0], ...values }],
  },
});

test("a late progress record from before the stop does not undo it", async (t) => {
  const { control, stops, snap, entry } = setup(t);
  await control.stop("s1", "agent1");
  const { at } = stops.get(session, "agent1");
  const late = withAgent(snap, {
    status: "running",
    runStartedAt: iso(at - 5000),
    updatedAt: iso(at + 1000),
  });
  assert.deepEqual(
    [entry("agent1", late).status, entry("agent1", late).canStop],
    ["stopped", false],
  );
  assert.equal(stops.has(session, "agent1"), true);
});

test("a run of the same agent that began after the stop wins and drops the stop", async (t) => {
  const { control, stops, snap, entry } = setup(t);
  await control.stop("s1", "agent1");
  const { at } = stops.get(session, "agent1");
  const resumed = withAgent(snap, { status: "running", runStartedAt: iso(at + 2000) });
  assert.deepEqual(
    [entry("agent1", resumed).status, entry("agent1", resumed).canStop],
    ["running", true],
  );
  assert.equal(stops.has(session, "agent1"), false);
  // Its later end reads as the CLI reports it.
  const ended = withAgent(snap, { status: "stopped", runStartedAt: iso(at + 2000) });
  assert.equal(entry("agent1", ended).status, "stopped");
  const running = withAgent(snap, { status: "running", runStartedAt: iso(at + 2000) });
  assert.equal(entry("agent1", running).status, "running");
});

test("a driver that sees a new run of a stopped task lets the native record win", async (t) => {
  const { control, driver, stops, entry } = setup(t);
  driver.result = { ok: true, run: "turn-1" };
  await control.stop("s1", "agent1");
  assert.equal(stops.get(session, "agent1").run, "turn-1");
  const asked = [];
  driver.resumed = (_session, task, mark) => {
    asked.push([task.id, mark.run]);
    return false;
  };
  assert.equal(entry("agent1").status, "stopped");
  driver.resumed = (_session, task, mark) => {
    asked.push([task.id, mark.run]);
    return true;
  };
  assert.deepEqual([entry("agent1").status, entry("agent1").canStop], ["running", true]);
  assert.deepEqual(asked, [
    ["agent1", "turn-1"],
    ["agent1", "turn-1"],
  ]);
  assert.equal(stops.has(session, "agent1"), false);
});

test("a stop that finds the task gone marks it ended: unknown, no note, not counted", async (t) => {
  const { control, driver, stops, changes, snap, entry, dataDir } = setup(t);
  driver.result = { ok: false, gone: true };
  await assert.rejects(control.stop("s1", "sh1"), { code: "TASK_STOP_NOT_RUNNING" });
  assert.equal(stops.get(session, "sh1").ended, true);
  assert.deepEqual([entry("sh1").status, entry("sh1").canStop], ["unknown", false]);
  assert.deepEqual(control.overlay(session, snap).observability.stopNotes, []);
  assert.deepEqual(changes, ["s1"]);
  await assert.rejects(control.stop("s1", "sh1"), { code: "TASK_STOP_NOT_RUNNING" });
  assert.equal(driver.calls.length, 1, "an ended task is not asked again");
  // It survives a restart.
  const again = new TaskControl({
    sessions: {},
    chat: {},
    reads: { flags: () => ({}) },
    stops: new TaskStopStore({ dataDir }),
  });
  again.register("claude", driver);
  const shell = again.overlay(session, snap).observability.shells[0];
  assert.deepEqual([shell.status, shell.canStop], ["unknown", false]);
});

test("a native completion wins over an ended mark, and a later run clears it", async (t) => {
  const { control, driver, stops, snap, entry } = setup(t);
  driver.result = { ok: false, gone: true };
  await assert.rejects(control.stop("s1", "agent1"), { code: "TASK_STOP_NOT_RUNNING" });
  const { at } = stops.get(session, "agent1");
  assert.equal(
    entry("agent1", withAgent(snap, { status: "completed" })).status,
    "completed",
  );
  assert.equal(entry("agent1").status, "unknown");
  const resumed = withAgent(snap, { status: "running", runStartedAt: iso(at + 1) });
  assert.equal(entry("agent1", resumed).status, "running");
  assert.equal(stops.has(session, "agent1"), false);
});

test("a shell that started after the mark under the same id is a new run", async (t) => {
  const { control, driver, stops, snap, entry } = setup(t);
  driver.result = { ok: false, gone: true };
  await assert.rejects(control.stop("s1", "sh1"), { code: "TASK_STOP_NOT_RUNNING" });
  const { at } = stops.get(session, "sh1");
  const shells = (startedAt) => ({
    observability: {
      ...snap.observability,
      shells: [{ ...snap.observability.shells[0], startedAt }],
    },
  });
  assert.equal(entry("sh1", shells(iso(at - 1))).status, "unknown");
  assert.equal(entry("sh1", shells(iso(at + 1))).status, "running");
});

test("an exception in onChange after a late success is logged, never unhandled", async (t) => {
  const { control, driver, stops } = setup(t);
  // The only stop here that must time out; the others keep the product's ten seconds.
  control.timeoutMs = 20;
  const logged = t.mock.method(console, "error", () => {});
  const unhandled = [];
  const listener = (error) => unhandled.push(error);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  control.onChange = () => {
    throw new Error("listener broke");
  };
  driver.stop = async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    return { ok: true };
  };
  await assert.rejects(control.stop("s1", "agent1"), { code: "TASK_STOP_TIMEOUT" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(unhandled, []);
  assert.equal(stops.has(session, "agent1"), true);
  assert.equal(logged.mock.callCount(), 1);
});

test("a stop note names an agent by its task, then its name, then its id", async (t) => {
  const notes = async (subagents) => {
    const { control, snap } = setup(t, { subagents });
    await control.stop("s1", subagents[0].id);
    return control.overlay(session, snap).observability.stopNotes[0].text;
  };
  const note = (label, id) =>
    `[AgentPier: the user stopped background task "${label}" (${id}).]`;
  assert.equal(
    await notes([
      {
        id: "a1",
        name: "general-purpose",
        task: 'Fix "the" bug\nnow' + "x".repeat(100),
        status: "running",
      },
    ]),
    note(`Fix 'the' bug now${"x".repeat(63)}`, "a1"),
  );
  assert.equal(
    await notes([{ id: "a2", name: "explorer", task: "", status: "running" }]),
    note("explorer", "a2"),
  );
  assert.equal(
    await notes([{ id: "a3", name: "", task: "", status: "running" }]),
    note("a3", "a3"),
  );
  const { control, snap } = setup(t, {
    shells: [
      { id: "sh2", command: "npm test", description: "Run tests", status: "running" },
    ],
  });
  await control.stop("s1", "sh2");
  assert.equal(
    control.overlay(session, snap).observability.stopNotes[0].text,
    note("Run tests", "sh2"),
  );
});
