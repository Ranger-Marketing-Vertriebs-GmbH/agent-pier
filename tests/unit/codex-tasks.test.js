import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  codexTaskTracker,
  codexTasksValue,
  codexTaskCommands,
} from "../../server/features/requests/codex-tasks.js";
import { nativePushValue } from "../../server/features/requests/native-push.js";
import { CodexTaskState } from "../../server/features/chat/codex-task-state.js";
import { codexTaskDriver } from "../../server/features/chat/codex-task-driver.js";
import { TaskControl } from "../../server/features/chat/task-control.js";

// Recorded on Codex 0.164.0 (spike a.frames.jsonl, ids replaced by neutral ones): a
// subagent thread whose terminal was terminated, and a thread with two terminals, one
// terminated and one that finished by itself.
const frames = fs
  .readFileSync(new URL("../fixtures/requests/codex-task-frames.jsonl", import.meta.url))
  .toString()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
const CHILD = "00000000-0000-4000-8000-000000000001";
const CHILD_TURN = "00000000-0000-4000-8000-000000000002";
const MAIN = "00000000-0000-4000-8000-000000000005";

function tracked() {
  const reports = [];
  const observe = codexTaskTracker((state) => reports.push(state));
  return { observe, reports, last: () => reports.at(-1) };
}

test("the tracker follows background terminals and child turns of the recorded frames", () => {
  const { observe, reports, last } = tracked();
  for (const frame of frames) observe(frame);
  assert.deepEqual(
    last().terminals.map((t) => [t.threadId, t.processId, t.status, t.exitCode]),
    [
      [CHILD, "92650", "stopped", -1],
      [MAIN, "18591", "stopped", -1],
      [MAIN, "43374", "completed", 0],
    ],
  );
  assert.equal(last().terminals[0].command, "/bin/zsh -lc 'sleep 240'");
  assert.equal(last().terminals[0].startedAt, 1794860031067);
  assert.equal(last().terminals[0].updatedAt, 1794860125448);
  assert.deepEqual(last().turns, []);
  assert.equal(last().terminalMethods, false);
  // While the child ran, its turn was known.
  const during = reports.find((state) => state.turns.length);
  assert.deepEqual(during.turns, [{ threadId: CHILD, turnId: CHILD_TURN }]);
  // A frame that changes nothing reports nothing.
  const count = reports.length;
  observe(frames.at(-1));
  observe({ method: "item/agentMessage/delta", params: { threadId: MAIN } });
  assert.equal(reports.length, count);
});

test("the tracker answers what the proxy checks before a command", () => {
  const { observe } = tracked();
  const turn = (method, turnId, status = "inProgress") =>
    observe({ method, params: { threadId: CHILD, turn: { id: turnId, status } } });
  turn("turn/started", "u1");
  assert.equal(observe.activeTurn(CHILD), "u1");
  turn("turn/completed", "u1", "completed");
  assert.equal(observe.activeTurn(CHILD), null);
  assert.equal(observe.turnEnd(CHILD, "u1"), "completed");
  for (const frame of frames.slice(0, 2)) observe(frame);
  assert.equal(observe.terminal(CHILD, "92650")?.status, "running");
  assert.equal(observe.terminal(CHILD, "1"), null);
});

test("the tracker keeps at most 64 turns and 100 terminals, and cuts commands", () => {
  const { observe, last } = tracked();
  for (let n = 0; n < 70; n += 1)
    observe({
      method: "turn/started",
      params: { threadId: `thread-${n}`, turn: { id: `turn-${n}` } },
    });
  assert.equal(last().turns.length, 64);
  assert.equal(last().turns[0].threadId, "thread-6");
  for (let n = 0; n < 110; n += 1)
    observe({
      method: "item/started",
      params: {
        threadId: MAIN,
        item: {
          type: "commandExecution",
          source: "unifiedExecStartup",
          processId: String(n),
          command: "x".repeat(2000),
          status: "inProgress",
        },
      },
    });
  assert.equal(last().terminals.length, 100);
  assert.equal(last().terminals[0].command.length, 1000);
  // Not a background terminal: a plain command, or one without a process.
  observe({
    method: "item/started",
    params: {
      threadId: MAIN,
      item: { type: "commandExecution", source: "agent", processId: "999" },
    },
  });
  observe({
    method: "item/started",
    params: {
      threadId: MAIN,
      item: { type: "commandExecution", source: "unifiedExecStartup" },
    },
  });
  assert.equal(
    last().terminals.some((t) => t.processId === "999"),
    false,
  );
  assert.equal(last().terminals.length, 100);
});

test("a tasks push is validated with the tracker's bounds", () => {
  const { observe, last } = tracked();
  for (const frame of frames) observe(frame);
  observe.setTerminalMethods(true);
  const push = { type: "tasks", ...last() };
  assert.deepEqual(nativePushValue(push), push);
  assert.deepEqual(codexTasksValue(push), push);
  const turn = { threadId: "t", turnId: "u" };
  const terminal = {
    threadId: "t",
    processId: "1",
    command: "sleep 1",
    status: "running",
    startedAt: 1,
    updatedAt: 1,
  };
  const invalid = [
    { turns: Array(65).fill(turn) },
    { terminals: Array(101).fill(terminal) },
    { turns: [{ threadId: "../x", turnId: "u" }] },
    { terminals: [{ ...terminal, processId: "1/2" }] },
    { terminals: [{ ...terminal, status: "gone" }] },
    { terminals: [{ ...terminal, command: "x".repeat(1001) }] },
    { terminals: [{ ...terminal, exitCode: 1.5 }] },
    { terminals: [{ ...terminal, startedAt: "yesterday" }] },
    { terminalMethods: "yes" },
    { turns: "none" },
  ];
  for (const change of invalid)
    assert.throws(
      () =>
        nativePushValue({
          type: "tasks",
          turns: [],
          terminals: [],
          terminalMethods: false,
          ...change,
        }),
      /Invalid native push/,
      JSON.stringify(change).slice(0, 80),
    );
});

/** A tracker that knows one running child turn and one running terminal. */
function proxyFake({ terminalMethods = true, answer = async () => ({}) } = {}) {
  const tracker = codexTaskTracker(() => {});
  tracker.setTerminalMethods(terminalMethods);
  tracker(frames[1]); // the child's terminal 92650 starts
  tracker({ method: "turn/started", params: { threadId: CHILD, turn: { id: "u1" } } });
  const sent = [];
  const request = async (method, params) => {
    sent.push([method, params]);
    return answer(method, params, tracker);
  };
  return { tracker, sent, run: codexTaskCommands({ request, tracker }) };
}

test("the proxy's commands send requests it builds itself from validated ids", async () => {
  const { sent, run } = proxyFake({
    answer: async (method) =>
      method.endsWith("terminate") ? { terminated: true } : { extra: 1 },
  });
  await run("turn.interrupt", { threadId: CHILD, turnId: "u1", extra: "x" });
  await run("terminal.terminate", { threadId: CHILD, processId: "92650", force: true });
  assert.deepEqual(sent, [
    ["turn/interrupt", { threadId: CHILD, turnId: "u1" }],
    ["thread/backgroundTerminals/terminate", { threadId: CHILD, processId: "92650" }],
  ]);
});

test("the proxy refuses commands for turns and terminals that are not running", async () => {
  const { sent, run } = proxyFake({ answer: async () => ({ terminated: false }) });
  const refusals = [
    ["turn.interrupt", { threadId: CHILD, turnId: "other" }, /turn not running/],
    ["turn.interrupt", { threadId: "../x", turnId: "u1" }, /turn not running/],
    ["turn.interrupt", null, /turn not running/],
    ["terminal.terminate", { threadId: CHILD, processId: "1" }, /terminal not running/],
    [
      "terminal.terminate",
      { threadId: MAIN, processId: "92650" },
      /terminal not running/,
    ],
    ["turn/start", {}, /unknown command/],
    ["__proto__", {}, /unknown command/],
  ];
  for (const [name, params, message] of refusals)
    await assert.rejects(run(name, params), message, name);
  assert.deepEqual(sent, []);
  // Codex says the terminal was not there: it ended by itself.
  await assert.rejects(
    run("terminal.terminate", { threadId: CHILD, processId: "92650" }),
    /terminal not running/,
  );
});

test("an interrupt of a turn that completed by itself meanwhile is no stop", async () => {
  const { run } = proxyFake({
    answer: async (method, params, tracker) => {
      // The turn ends on its own before Codex answers the interrupt.
      tracker({
        method: "turn/completed",
        params: { threadId: CHILD, turn: { id: "u1", status: "completed" } },
      });
      return {};
    },
  });
  await assert.rejects(
    run("turn.interrupt", { threadId: CHILD, turnId: "u1" }),
    /turn not running/,
  );
});

test("without the terminal methods the proxy refuses to terminate", async () => {
  const { sent, run } = proxyFake({ terminalMethods: false });
  await assert.rejects(
    run("terminal.terminate", { threadId: CHILD, processId: "92650" }),
    /terminal methods unavailable/,
  );
  assert.deepEqual(sent, []);
});

function stateWith(push, providerSessionId = MAIN) {
  const changes = [];
  const state = new CodexTaskState({ onChange: (id) => changes.push(id) });
  state.report("s", push);
  return { state, changes, providerSessionId };
}
const running = (threadId, processId, command = "sleep 300") => ({
  threadId,
  processId,
  command,
  status: "running",
  startedAt: 1794860031067,
  updatedAt: 1794860031067,
});

test("the server's task state lists Codex shells with their owner agent", () => {
  const { state, changes } = stateWith({
    type: "tasks",
    turns: [{ threadId: CHILD, turnId: "u1" }],
    terminals: [
      running(CHILD, "92650"),
      { ...running(MAIN, "18591"), status: "stopped", exitCode: -1 },
    ],
    terminalMethods: true,
  });
  assert.deepEqual(changes, ["s"]);
  assert.deepEqual(state.shells("s", MAIN), [
    {
      id: `${CHILD}:92650`,
      command: "sleep 300",
      status: "running",
      startedAt: "2026-11-16T20:13:51.067Z",
      updatedAt: "2026-11-16T20:13:51.067Z",
      ownerAgentId: CHILD,
    },
    {
      id: `${MAIN}:18591`,
      command: "sleep 300",
      status: "stopped",
      exitCode: -1,
      startedAt: "2026-11-16T20:13:51.067Z",
      updatedAt: "2026-11-16T20:13:51.067Z",
    },
  ]);
  assert.equal(state.turn("s", CHILD), "u1");
  assert.equal(state.turn("s", MAIN), null);
  assert.equal(state.terminalMethods("s"), true);
  assert.deepEqual(state.shells("other", MAIN), []);
  assert.equal(state.terminalMethods("other"), false);
  state.forget("s");
  assert.deepEqual(state.shells("s", MAIN), []);
  assert.deepEqual(changes, ["s", "s"]);
});

function driverWith(push, answers = {}, options = {}) {
  const { state } = stateWith(push);
  const sent = [];
  const commands = {
    connected: (id) => id === "s",
    send: async (id, command) => {
      sent.push(command);
      const answer = answers[command.name];
      return typeof answer === "function" ? answer(command) : (answer ?? { ok: true });
    },
  };
  return { driver: codexTaskDriver({ commands, state, ...options }), sent, state };
}
const session = { id: "s", tool: "codex", status: "running" };
const agent = (id = CHILD) => ({ kind: "agent", id, entry: { id, status: "running" } });
const shell = (id) => ({ kind: "shell", id, entry: { id, status: "running" } });

test("an agent stop interrupts the child's turn, then terminates its running terminals", async () => {
  const { driver, sent } = driverWith({
    type: "tasks",
    turns: [{ threadId: CHILD, turnId: "u1" }],
    terminals: [
      running(CHILD, "1"),
      running(CHILD, "2"),
      { ...running(CHILD, "3"), status: "completed", exitCode: 0 },
      running(MAIN, "4"),
    ],
    terminalMethods: true,
  });
  assert.equal(driver.canStop(session, agent()), true);
  assert.deepEqual(await driver.stop(session, agent()), { ok: true, run: "u1" });
  assert.deepEqual(sent, [
    { name: "turn.interrupt", params: { threadId: CHILD, turnId: "u1" } },
    { name: "terminal.terminate", params: { threadId: CHILD, processId: "1" } },
    { name: "terminal.terminate", params: { threadId: CHILD, processId: "2" } },
  ]);
});

test("without the terminal methods an agent stop only interrupts and shells cannot stop", async () => {
  const { driver, sent } = driverWith({
    type: "tasks",
    turns: [{ threadId: CHILD, turnId: "u1" }],
    terminals: [running(CHILD, "1")],
    terminalMethods: false,
  });
  assert.equal(driver.canStop(session, shell(`${CHILD}:1`)), false);
  assert.deepEqual(await driver.stop(session, agent()), { ok: true, run: "u1" });
  assert.deepEqual(sent, [
    { name: "turn.interrupt", params: { threadId: CHILD, turnId: "u1" } },
  ]);
});

test("a shell stop terminates exactly that terminal", async () => {
  const { driver, sent } = driverWith({
    type: "tasks",
    turns: [],
    terminals: [running(MAIN, "18591")],
    terminalMethods: true,
  });
  assert.equal(driver.canStop(session, shell(`${MAIN}:18591`)), true);
  assert.deepEqual(await driver.stop(session, shell(`${MAIN}:18591`)), { ok: true });
  assert.deepEqual(sent, [
    { name: "terminal.terminate", params: { threadId: MAIN, processId: "18591" } },
  ]);
});

test("a task that ended by itself is gone, never stopped", async () => {
  const { driver, sent } = driverWith(
    {
      type: "tasks",
      turns: [{ threadId: CHILD, turnId: "u1" }],
      terminals: [running(MAIN, "18591"), { ...running(MAIN, "5"), status: "completed" }],
      terminalMethods: true,
    },
    {
      "turn.interrupt": { ok: false, reason: "thread not found: x" },
      "terminal.terminate": { ok: false, reason: "terminal not running" },
    },
  );
  assert.deepEqual(await driver.stop(session, agent()), {
    ok: false,
    gone: true,
    reason: "thread not found: x",
  });
  assert.deepEqual(await driver.stop(session, shell(`${MAIN}:18591`)), {
    ok: false,
    gone: true,
    reason: "terminal not running",
  });
  // Known finished or unknown: nothing is sent.
  sent.length = 0;
  assert.equal((await driver.stop(session, shell(`${MAIN}:5`))).gone, true);
  assert.equal((await driver.stop(session, agent("unknown-thread"))).gone, true);
  assert.deepEqual(sent, []);
});

test("an agent whose turn the proxy never saw cannot be stopped", () => {
  const { driver } = driverWith({
    type: "tasks",
    turns: [],
    terminals: [],
    terminalMethods: true,
  });
  assert.equal(driver.canStop(session, agent()), false);
  assert.equal(driver.connected(session), true);
  assert.equal(driver.connected({ ...session, id: "t" }), false);
});

test("the stop control lists Codex shells and stops one through the driver", async () => {
  const { driver, state } = driverWith({
    type: "tasks",
    turns: [],
    terminals: [running(MAIN, "18591")],
    terminalMethods: true,
  });
  const sessions = new Map([["s", session]]);
  const snapshot = {
    providerSessionId: MAIN,
    observability: { subagents: [], shells: [] },
  };
  const control = new TaskControl({
    sessions: { get: async (id) => sessions.get(id) },
    chat: { read: async () => control.overlay(session, snapshot) },
    reads: { flags: (s, kind) => (kind === "shell" ? { hasOutput: false } : {}) },
    stops: { has: () => false, get: () => null, record: () => {}, forget: () => {} },
    onChange: () => {},
  });
  control.register("codex", driver);
  const shells = control.overlay(session, snapshot).observability.shells;
  assert.deepEqual(
    shells.map((entry) => [entry.id, entry.status, entry.canStop, entry.hasOutput]),
    [[`${MAIN}:18591`, "running", true, false]],
  );
  assert.deepEqual(await control.stop("s", `${MAIN}:18591`), { stopped: true });
  state.report("s", {
    type: "tasks",
    turns: [],
    terminals: [{ ...running(MAIN, "18591"), status: "stopped", exitCode: -1 }],
    terminalMethods: true,
  });
  await assert.rejects(control.stop("s", `${MAIN}:18591`), {
    code: "TASK_STOP_NOT_RUNNING",
  });
});

test("every report the tracker emits passes the push validation", () => {
  // A malformed id would make every push invalid and the broker would drop the channel.
  const { observe, reports } = tracked();
  const odd = ["x".repeat(101), "a:b", "a.b", "", "-a", 42, null];
  for (const id of odd) {
    observe({ method: "turn/started", params: { threadId: CHILD, turn: { id } } });
    observe({ method: "turn/started", params: { threadId: id, turn: { id: "u1" } } });
    for (const processId of [id, "1"])
      observe({
        method: "item/started",
        params: {
          threadId: id,
          item: { type: "commandExecution", source: "unifiedExecStartup", processId },
        },
      });
  }
  observe({
    method: "item/started",
    params: {
      threadId: MAIN,
      startedAtMs: -5,
      item: {
        type: "commandExecution",
        source: "unifiedExecStartup",
        processId: "7",
        command: { not: "text" },
      },
    },
  });
  observe({
    method: "item/completed",
    params: {
      threadId: MAIN,
      completedAtMs: 1.5,
      item: {
        type: "commandExecution",
        source: "unifiedExecStartup",
        processId: "7",
        exitCode: 2 ** 60,
      },
    },
  });
  observe({ method: "turn/started", params: { threadId: CHILD, turn: { id: "u2" } } });
  for (const frame of frames) observe(frame);
  for (const report of reports)
    assert.doesNotThrow(() => codexTasksValue({ type: "tasks", ...report }));
  assert.deepEqual(
    reports
      .flatMap((report) => report.turns.map((turn) => turn.turnId))
      .filter((turn) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(turn)),
    [],
  );
});

test("an interrupt Codex does not answer in time is the stop's timeout", async () => {
  const { driver } = driverWith(
    {
      type: "tasks",
      turns: [{ threadId: CHILD, turnId: "u1" }],
      terminals: [running(MAIN, "18591")],
      terminalMethods: true,
    },
    {
      "turn.interrupt": { ok: false, reason: "turn/interrupt: no answer from Codex" },
      "terminal.terminate": {
        ok: false,
        reason: "thread/backgroundTerminals/terminate: no answer from Codex",
      },
    },
  );
  await assert.rejects(driver.stop(session, agent()), { code: "TASK_STOP_TIMEOUT" });
  await assert.rejects(driver.stop(session, shell(`${MAIN}:18591`)), {
    code: "TASK_STOP_TIMEOUT",
  });
});

test("after an interrupt the terminates run at once, bounded, and never fail the stop", async () => {
  const started = [];
  const { driver, state } = driverWith(
    {
      type: "tasks",
      turns: [{ threadId: CHILD, turnId: "u1" }],
      terminals: [running(CHILD, "1"), running(CHILD, "2"), running(CHILD, "3")],
      terminalMethods: true,
    },
    {
      "terminal.terminate": ({ params }) => {
        started.push(params.processId);
        if (params.processId === "1") return new Promise(() => {}); // never answers
        if (params.processId === "2") throw Error("channel down");
        return { ok: false, reason: "refused" };
      },
    },
    { terminateBoundMs: 30 },
  );
  const begun = Date.now();
  assert.deepEqual(await driver.stop(session, agent()), { ok: true, run: "u1" });
  assert.ok(Date.now() - begun < 1000);
  assert.deepEqual(started, ["1", "2", "3"]);
  // A terminal that could not be terminated stays listed running, stoppable on its own.
  assert.equal(state.terminal("s", `${CHILD}:1`).status, "running");
  assert.equal(driver.canStop(session, shell(`${CHILD}:1`)), true);
});

test("without the session's own thread no shell names an owner agent", () => {
  const { state } = stateWith({
    type: "tasks",
    turns: [],
    terminals: [running(MAIN, "1"), running(CHILD, "2")],
    terminalMethods: true,
  });
  assert.deepEqual(
    state.shells("s", undefined).map((entry) => entry.ownerAgentId),
    [undefined, undefined],
  );
  assert.deepEqual(
    state.shells("s", MAIN).map((entry) => entry.ownerAgentId),
    [undefined, CHILD],
  );
});
