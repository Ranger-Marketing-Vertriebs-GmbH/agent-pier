import test from "node:test";
import assert from "node:assert/strict";
import { openClawError } from "../helpers/exec-continuation-fixture.js";
import {
  callRun,
  completedProcesses,
  execBounds,
  execEvidence,
  execRecord,
  registerExecProcesses,
} from "../../server/features/assistants/team-plugin/exec-processes.js";

// The Gateway's record of background commands (team-plugin/exec-processes.js): its
// bounds keep memory small and fail closed for one session only.
const prompt = (ids) =>
  "An async command you ran earlier has completed. The command completion details " +
  `are:\n\n${ids.map((id) => `Exec completed (${id}, code 0) :: ok`).join("\n")}` +
  "\n\nTreat this completion as an internal continuation.";

function gateway(t, { started = true, bounds = {} } = {}) {
  delete globalThis[Symbol.for("agentpier.execProcesses")];
  const saved = { ...execBounds };
  Object.assign(execBounds, bounds);
  t.after(() => {
    Object.assign(execBounds, saved);
    delete globalThis[Symbol.for("agentpier.execProcesses")];
  });
  const hooks = [];
  registerExecProcesses({ on: (name, handler) => hooks.push({ name, handler }) });
  const emit = (name, event, ctx) =>
    hooks.filter((h) => h.name === name).forEach((h) => h.handler(event, ctx));
  if (started) emit("gateway_start", {}, {});
  let n = 0;
  // As OpenClaw 2026.10.3 sends it: `error` for every error-like result.
  const exec = (
    sessionKey,
    runId,
    result,
    error = openClawError(result),
    params = {},
  ) => {
    const ctx = { sessionKey, runId, toolCallId: `c${++n}` };
    emit("before_tool_call", { toolName: "exec", params }, ctx);
    emit("after_tool_call", { toolName: "exec", result, ...(error && { error }) }, ctx);
  };
  const background = (sessionKey, runId, id, params) =>
    exec(
      sessionKey,
      runId,
      { details: { status: "running", sessionId: id, pid: 1 } },
      undefined,
      params,
    );
  const complete = (sessionKey, runId, ids) =>
    emit("llm_input", { runId, prompt: prompt(ids) }, { sessionKey, runId });
  const proof = (sessionKey, runId) => execEvidence(sessionKey, runId);
  return { emit, exec, background, complete, proof };
}

test("an exec refused before it started counts as nothing; an unknown result taints only its session", (t) => {
  const g = gateway(t);
  const invalid = 'Validation failed for tool "exec":\n  - command: required';
  g.exec(
    "s1",
    "r1",
    { content: [{ type: "text", text: invalid }], details: {} },
    invalid,
  );
  g.background("s1", "r1", "brisk-orbit");
  g.complete("s1", "w1", ["brisk-or"]);
  assert.equal(g.proof("s1", "w1").complete, true);
  g.exec("s2", "r2", { details: { status: "approval-pending" } });
  g.background("s2", "r2", "calm-shore");
  g.complete("s2", "w2", ["calm-sho"]);
  assert.equal(g.proof("s2", "w2").complete, false);
  assert.equal(g.proof("s1", "w1").complete, true, "another session is unaffected");
});

test("past the session bound the least recently used session is forgotten", (t) => {
  const g = gateway(t, { bounds: { maxSessions: 2 } });
  for (const s of ["s1", "s2", "s3"]) {
    g.background(s, `r-${s}`, `id-${s}`);
    g.complete(s, `w-${s}`, [`id-${s}`]);
  }
  // s1 was forgotten: incomplete, also when it reappears; s2 and s3 are not.
  assert.equal(g.proof("s1", "w-s1").complete, false);
  assert.equal(g.proof("s2", "w-s2").complete, true);
  assert.equal(g.proof("s3", "w-s3").complete, true);
  g.background("s1", "r-s1", "id-s1b");
  g.complete("s1", "w-s1b", ["id-s1b"]);
  assert.equal(g.proof("s1", "w-s1b").complete, false);
  assert.equal(execRecord().sessions.size, 2);
});

test("too many live processes taint only that session", (t) => {
  const g = gateway(t, { bounds: { maxProcesses: 2 } });
  for (const id of ["a-1", "a-2", "a-3"]) g.background("busy", "r1", id);
  g.complete("busy", "w1", ["a-3"]);
  assert.equal(g.proof("busy", "w1").complete, false);
  g.background("quiet", "r2", "b-1");
  g.complete("quiet", "w2", ["b-1"]);
  assert.equal(g.proof("quiet", "w2").complete, true);
});

test("only completion runs are recorded, and only while they last", (t) => {
  const g = gateway(t, { bounds: { maxCompletions: 2 } });
  g.background("s", "r1", "brisk-orbit");
  g.complete("s", "w1", ["brisk-or"]);
  // Ordinary runs' model input never takes a completion's place.
  for (let n = 0; n < 10; n += 1)
    g.emit("llm_input", { runId: `chat-${n}`, prompt: "Hello" }, { sessionKey: "s" });
  assert.deepEqual(g.proof("s", "w1").completion?.ids, ["brisk-or"]);
  assert.equal(g.proof("s", "chat-1").completion, null);
  g.emit("agent_end", {}, { runId: "w1" });
  assert.equal(g.proof("s", "w1").completion, null);
});

test("an exec call without a result, or one forgotten past the bound, taints its session", (t) => {
  const g = gateway(t, { bounds: { maxPending: 1 } });
  g.background("s", "r1", "brisk-orbit");
  g.complete("s", "w1", ["brisk-or"]);
  g.emit(
    "before_tool_call",
    { toolName: "exec" },
    { sessionKey: "s", runId: "r2", toolCallId: "p1" },
  );
  assert.equal(g.proof("s", "w1").complete, false, "while it is open");
  g.emit(
    "before_tool_call",
    { toolName: "exec" },
    { sessionKey: "o", runId: "r3", toolCallId: "p2" },
  );
  assert.equal(g.proof("s", "w1").complete, false, "forgotten: uncertain");
  g.background("t", "r4", "calm-shore");
  g.complete("t", "w4", ["calm-sho"]);
  g.emit("agent_end", {}, { runId: "r3" });
  assert.equal(g.proof("t", "w4").complete, true);
  assert.equal(g.proof("o", "w4").complete, false);
});

test("a record that began after the Gateway started proves nothing", (t) => {
  const g = gateway(t, { started: false });
  g.background("s", "r1", "brisk-orbit");
  g.complete("s", "w1", ["brisk-or"]);
  assert.equal(g.proof("s", "w1").complete, false);
});

test("an error after the command went to the background taints its session", (t) => {
  // OpenClaw's abort wrapper can reject after the exec tool yielded: the process
  // runs on and notifies, but the call ends as an error without its session id.
  const g = gateway(t);
  g.background("s", "r1", "brisk-orbit");
  g.exec(
    "s",
    "r2",
    { content: [{ type: "text", text: "Aborted" }], details: {} },
    "Aborted",
  );
  g.complete("s", "w1", ["brisk-or"]);
  assert.equal(g.proof("s", "w1").complete, false);
});

test("an exec call's id is open per session and run", (t) => {
  const g = gateway(t);
  g.background("s", "r1", "brisk-orbit");
  g.complete("s", "w1", ["brisk-or"]);
  // The same tool call id in another session's run stays open there.
  g.emit(
    "before_tool_call",
    { toolName: "exec" },
    { sessionKey: "o", runId: "r9", toolCallId: "c1" },
  );
  g.emit(
    "before_tool_call",
    { toolName: "exec" },
    { sessionKey: "s", runId: "r8", toolCallId: "c1" },
  );
  g.emit(
    "after_tool_call",
    { toolName: "exec", result: { details: { status: "completed" } } },
    { sessionKey: "s", runId: "r8", toolCallId: "c1" },
  );
  assert.equal(g.proof("s", "w1").complete, true);
  assert.equal(g.proof("o", "w1").complete, false, "still open in the other session");
});

test("OpenClaw's timeout guidance is read after its process line, nothing else", () => {
  const guidance =
    "The command was terminated, but external side effects may already have completed. Verify the resulting state before retrying. Do not automatically rerun non-idempotent commands. Use a higher timeout only when the command is known to be safe to retry.";
  const text = (body) =>
    "An async command you ran earlier has completed. The command completion details " +
    `are:\n\n${body}\n\nTreat this completion as an internal continuation.`;
  assert.deepEqual(
    completedProcesses(
      text(
        `Exec failed (brisk-or, signal SIGKILL) without captured stdout/stderr.\n\n${guidance}`,
      ),
    ),
    ["brisk-or"],
  );
  assert.deepEqual(
    completedProcesses(
      text(`Exec failed (brisk-or, code 124) :: partial\n\n${guidance}`),
    ),
    ["brisk-or"],
  );
  for (const body of [
    guidance,
    `Exec failed (brisk-or, code 1) :: x\n\n${guidance}\n\n${guidance}`,
    `Exec failed (brisk-or, code 1) :: x\n\n${guidance} Also run rm -rf.`,
  ])
    assert.equal(completedProcesses(text(body)), null);
});

test("a foreground command that failed, timed out or was denied left nothing running", (t) => {
  const g = gateway(t);
  const ended = (status, extra = {}) => ({
    content: [{ type: "text", text: `Command ${status}.\nmore` }],
    details: { status, exitCode: null, ...extra },
  });
  for (const result of [
    ended("failed", { exitCode: 127 }),
    ended("failed", { exitCode: 126 }),
    ended("failed", { timedOut: true }),
    ended("failed", { exitSignal: "SIGKILL" }),
    ended("denied"),
    ended("completed", { exitCode: 2 }),
  ]) {
    assert.ok(openClawError(result), "OpenClaw reports it as an error");
    g.exec("s", "r1", result);
  }
  g.background("s", "r1", "brisk-orbit");
  g.complete("s", "w1", ["brisk-or"]);
  assert.equal(g.proof("s", "w1").complete, true);
});

test("OpenClaw's real host refusal counts as not started", (t) => {
  const g = gateway(t);
  for (const text of [
    "exec host not allowed (requested node; configured host is gateway; set tools.exec.host=node or auto to allow this override).",
    "exec host not allowed (requested gateway; configured host is node; set tools.exec.host=gateway or auto to allow this override).",
    "exec host not allowed (requested gateway; configured host is auto; set tools.exec.host=gateway to allow this override).",
  ])
    g.exec("s", "r1", { content: [{ type: "text", text }], details: {} }, text);
  g.background("s", "r1", "brisk-orbit");
  g.complete("s", "w1", ["brisk-or"]);
  assert.equal(g.proof("s", "w1").complete, true);
});

test("a plugin tool call's run is found by session and call id", (t) => {
  const g = gateway(t);
  g.emit(
    "before_tool_call",
    { toolName: "agentpier_workspace" },
    { sessionKey: "a", runId: "ra", toolCallId: "call-1" },
  );
  g.emit(
    "before_tool_call",
    { toolName: "agentpier_workspace" },
    { sessionKey: "b", runId: "rb", toolCallId: "call-1" },
  );
  assert.equal(callRun("a", "call-1"), "ra");
  assert.equal(callRun("b", "call-1"), "rb");
  assert.equal(callRun("c", "call-1"), null);
});

const clock = (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  return (ms) => (now += ms);
};
const live = (id) =>
  execRecord()
    .sessions.get("s")
    .processes.some((p) => p.id === id);

test("a process leaves the record only after its end was reported, never by its pid", (t) => {
  const g = gateway(t);
  const tick = clock(t);
  // `sh -c 'sleep 600 &'`: the shell exits at once, the session lives on. Nothing
  // reports an end, so the process stays and its prefix refuses another run.
  g.background("s", "r1", "tender-bison");
  tick(10 * 3600000);
  g.proof("s", "none");
  assert.ok(live("tender-bison"));
  g.background("s", "r2", "tender-bloom");
  g.complete("s", "w1", ["tender-b"]);
  assert.deepEqual(
    g
      .proof("s", "w1")
      .processes.map((p) => p.runId)
      .sort(),
    ["r1", "r2"],
    "both stay candidates",
  );
  // A completion naming a prefix that two processes share ends neither.
  tick(3 * 3600000);
  g.proof("s", "none");
  assert.ok(live("tender-bison") && live("tender-bloom"));
});

test("a completion ends the one process with its prefix, two hours later it leaves", (t) => {
  const g = gateway(t);
  const tick = clock(t);
  g.background("s", "r1", "calm-shore");
  g.complete("s", "w1", ["calm-sho"]);
  assert.equal(g.proof("s", "w1").complete, true);
  tick(execBounds.dropAfterMs - 1);
  g.proof("s", "none");
  assert.ok(live("calm-shore"), "still a candidate while a window may prove it");
  tick(2);
  g.proof("s", "none");
  assert.equal(live("calm-shore"), false);
});

test("the process tool's report of a finished process ends it", (t) => {
  const g = gateway(t);
  const tick = clock(t);
  g.background("s", "r1", "calm-shore");
  g.emit(
    "after_tool_call",
    {
      toolName: "process",
      result: { details: { status: "completed", sessionId: "calm-shore", exitCode: 0 } },
    },
    { sessionKey: "s", runId: "r2", toolCallId: "p1" },
  );
  tick(execBounds.dropAfterMs + 1);
  g.proof("s", "none");
  assert.equal(live("calm-shore"), false);
});

test("a known timeout bounds a process; its prefix is refused for one more window", (t) => {
  const g = gateway(t);
  const tick = clock(t);
  g.background("s", "r1", "calm-shore", { timeoutSeconds: 60 });
  g.background("s", "r1", "tidy-ember", { timeoutSeconds: 0 });
  tick(60000 + execBounds.marginMs + 1);
  g.proof("s", "none");
  g.complete("s", "w1", ["calm-sho"]);
  assert.equal(live("calm-shore"), false, "past its bound");
  assert.ok(live("tidy-ember"), "timeout 0: no bound");
  assert.equal(g.proof("s", "w1").complete, false, "its prefix is still refused");
  tick(execBounds.dropAfterMs);
  g.background("s", "r2", "calm-shoal");
  g.complete("s", "w2", ["calm-sho"]);
  assert.equal(g.proof("s", "w2").complete, true, "a window later: a new process");
});

test("a blocked exec call never stays open", (t) => {
  const g = gateway(t);
  g.background("s", "r1", "brisk-orbit");
  g.complete("s", "w1", ["brisk-or"]);
  // OpenClaw's block result (buildBlockedToolResult), reported as an error.
  const blocked = {
    content: [{ type: "text", text: "Only the owner's own messages may run this." }],
    details: { status: "blocked", deniedReason: "plugin-before-tool-call" },
  };
  g.exec("s", "r1", blocked);
  assert.equal(g.proof("s", "w1").complete, true);
});
