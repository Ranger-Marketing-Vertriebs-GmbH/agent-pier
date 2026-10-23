import test from "node:test";
import assert from "node:assert/strict";
import {
  stepCall,
  stepRefusals,
} from "../../server/features/assistants/team-plugin/tool-guard.js";
import { stepPolicy } from "../../server/features/assistants/memory-step-tools.js";

const ctx = { agentId: "ap-a1", sessionKey: "agent:ap-a1:dashboard:x", runId: "r1" };
const event = { toolName: "exec" };
// A bridge transport that answers with this response (or rejects) and records asks.
function transport(respond) {
  const asked = [];
  const call = async (endpoint, body) => {
    asked.push({ endpoint, body });
    return respond();
  };
  return Object.assign(call, { asked });
}
const answer =
  (body, ok = true) =>
  () => ({ ok, json: async () => body });

test("the step hook names a memory step only when the bridge refuses for one", async () => {
  const step = transport(answer({ allow: false, reason: "memoryStep" }));
  assert.deepEqual(await stepCall(event, ctx, step), {
    block: true,
    blockReason: stepRefusals.memoryStep,
  });
  assert.equal(step.asked[0].endpoint, "/step-policy");
  assert.deepEqual(step.asked[0].body, { ...ctx, toolName: "exec" });
  assert.equal(await stepCall(event, ctx, transport(answer({ allow: true }))), undefined);
});

test("the step hook says AgentPier is unreachable when the bridge does not answer", async () => {
  const unreachable = {
    block: true,
    blockReason: "AgentPier is not reachable right now; try again shortly.",
  };
  const cases = {
    rejected: () => Promise.reject(new TypeError("fetch failed")),
    timeout: () => Promise.reject(new DOMException("timed out", "TimeoutError")),
    status: answer({ allow: true }, false),
    unparsable: () => ({ ok: true, json: async () => Promise.reject(SyntaxError()) }),
    closing: answer({ allow: false, reason: "unavailable" }),
    noReason: answer({ allow: false }),
  };
  for (const [name, respond] of Object.entries(cases))
    assert.deepEqual(await stepCall(event, ctx, transport(respond)), unreachable, name);
  assert.doesNotMatch(stepRefusals.unavailable, /memory/i);
});

test("a call of no agent never asks the step policy", async () => {
  const bridge = transport(answer({ allow: false, reason: "memoryStep" }));
  assert.equal(await stepCall(event, {}, bridge), undefined);
  assert.equal(bridge.asked.length, 0);
});

test("the step policy gives the reason the hook names", () => {
  const attempt = { id: "a1", requestId: "q1", state: "running" };
  const bridge = (kind, closed = false) => ({
    closed,
    bound: () => [attempt],
    teams: { store: { context: () => ({ kind }) } },
    assistants: { ledger: { attemptForRun: () => null } },
  });
  const input = { agentId: "ap-a1", sessionKey: ctx.sessionKey, toolName: "exec" };
  assert.deepEqual(stepPolicy(bridge("memory-step"), input), {
    allow: false,
    reason: "memoryStep",
  });
  assert.deepEqual(stepPolicy(bridge("memory-step"), { ...input, toolName: "read" }), {
    allow: true,
  });
  assert.deepEqual(stepPolicy(bridge("owner"), input), { allow: true });
  assert.deepEqual(stepPolicy(bridge("owner", true), input), {
    allow: false,
    reason: "unavailable",
  });
});
