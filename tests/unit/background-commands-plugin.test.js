import test from "node:test";
import assert from "node:assert/strict";
import {
  execRecord,
  liveProcesses,
  recordExec,
  registerExecProcesses,
} from "../../server/features/assistants/team-plugin/exec-processes.js";
import {
  backgroundMethod,
  registerBackgroundCommands,
} from "../../server/features/assistants/team-plugin/background-commands.js";

function fresh(t) {
  delete globalThis[Symbol.for("agentpier.execProcesses")];
  t.after(() => delete globalThis[Symbol.for("agentpier.execProcesses")]);
  const hooks = [];
  registerExecProcesses({ on: (name, handler) => hooks.push({ name, handler }) });
  const emit = (name, event, ctx) =>
    hooks.filter((h) => h.name === name).forEach((h) => h.handler(event, ctx));
  emit("gateway_start", {}, {});
  return emit;
}

test("a backgrounded exec counts as running until its end is observed", (t) => {
  const emit = fresh(t);
  recordExec(
    execRecord(),
    {
      result: { details: { status: "running", sessionId: "brisk-otter" } },
      params: { timeoutSeconds: 0 },
    },
    { sessionKey: "s", runId: "r" },
  );
  assert.deepEqual(liveProcesses("s"), { complete: true, running: 1, completing: 0 });
  emit(
    "after_tool_call",
    {
      toolName: "process",
      result: { details: { status: "completed", sessionId: "brisk-otter" } },
    },
    { sessionKey: "s", runId: "r2" },
  );
  assert.equal(liveProcesses("s").running, 0);
  assert.equal(liveProcesses("other").running, 0);
});

test("a 2026.10.7 completion run counts as completing until its end", (t) => {
  const emit = fresh(t);
  recordExec(
    execRecord(),
    { result: { details: { status: "running", sessionId: "brisk-otter" } } },
    { sessionKey: "s", runId: "owner" },
  );
  const prompt = "[Sat 2026-10-24 14:31 GMT+2] Exec completed (brisk-ot, code 0) :: ok";
  // A typed line is a user turn: nothing completes.
  emit("llm_input", { runId: "typed", prompt }, { sessionKey: "s", trigger: "user" });
  assert.deepEqual(liveProcesses("s"), { complete: true, running: 1, completing: 0 });
  emit("llm_input", { runId: "c1", prompt }, { sessionKey: "s", trigger: "event" });
  assert.deepEqual(liveProcesses("s"), { complete: true, running: 0, completing: 1 });
  assert.equal(liveProcesses("other").completing, 0);
  emit("agent_end", {}, { sessionKey: "s", runId: "c1", trigger: "event" });
  assert.equal(liveProcesses("s").completing, 0);
});

test("a session with an unknown exec result is not complete", (t) => {
  fresh(t);
  recordExec(
    execRecord(),
    { result: { details: { status: "approval-pending" } } },
    {
      sessionKey: "s",
      runId: "r",
    },
  );
  assert.equal(liveProcesses("s").complete, false);
});

test("the method answers counts only, admin scope, and refuses bad input", async (t) => {
  fresh(t);
  recordExec(
    execRecord(),
    { result: { details: { status: "running", sessionId: "brisk-otter" } } },
    { sessionKey: "s", runId: "r" },
  );
  let registered;
  registerBackgroundCommands({
    registerGatewayMethod: (name, handler, options) =>
      (registered = { name, handler, options }),
  });
  assert.equal(registered.name, backgroundMethod);
  assert.equal(registered.name, "agentpier.backgroundCommands");
  assert.equal(registered.options.scope, "operator.admin");
  const call = async (params) => {
    const out = [];
    await registered.handler({ params, respond: (...args) => out.push(args) });
    return out;
  };
  for (const params of [
    {},
    undefined,
    { sessionKey: 1 },
    { sessionKey: "x".repeat(513) },
  ])
    assert.deepEqual(await call(params), [
      [
        false,
        undefined,
        { code: "INVALID_REQUEST", message: "invalid background commands request" },
      ],
    ]);
  assert.deepEqual(await call({ sessionKey: "s" }), [
    [true, { complete: true, running: 1, completing: 0 }],
  ]);
});
