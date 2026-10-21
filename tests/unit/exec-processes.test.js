import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
  const exec = (sessionKey, runId, result, error) => {
    const ctx = { sessionKey, runId, toolCallId: `c${++n}` };
    emit("before_tool_call", { toolName: "exec" }, ctx);
    emit("after_tool_call", { toolName: "exec", result, ...(error && { error }) }, ctx);
  };
  const background = (sessionKey, runId, id, pid) =>
    exec(sessionKey, runId, { details: { status: "running", sessionId: id, pid } });
  const complete = (sessionKey, runId, ids) =>
    emit("llm_input", { runId, prompt: prompt(ids) }, { sessionKey, runId });
  const proof = (sessionKey, runId) => execEvidence(sessionKey, runId);
  return { emit, exec, background, complete, proof };
}

test("an errored exec started nothing; an unknown result taints only its session", (t) => {
  const g = gateway(t);
  g.exec(
    "s1",
    "r1",
    { content: [{ type: "text", text: "Provide a command." }], details: {} },
    "Provide a command.",
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

test("a process long gone is dropped, and its prefix stays refused", (t) => {
  const g = gateway(t, { bounds: { dropAfterMs: 0 } });
  // A pid that existed and has exited; the test runner's own pid is alive.
  const { pid: gone } = spawnSync(process.execPath, ["-e", ""]);
  g.background("s", "r1", "tender-bison", gone);
  g.background("s", "r1", "calm-shore", process.pid);
  g.complete("s", "w1", ["calm-sho"]);
  assert.deepEqual(g.proof("s", "w1"), {
    complete: true,
    processes: [{ id: "calm-shore", runId: "r1" }],
    completion: g.proof("s", "w1").completion,
  });
  assert.equal(
    execRecord()
      .sessions.get("s")
      .processes.some((p) => p.id === "tender-bison"),
    false,
    "dropped",
  );
  g.complete("s", "w2", ["tender-b"]);
  assert.equal(g.proof("s", "w2").complete, false, "a dropped prefix proves nothing");
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
