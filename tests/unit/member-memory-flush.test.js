import test from "node:test";
import assert from "node:assert/strict";
import { flushWrite } from "../../server/features/assistants/memory-write-policy.js";
import { flushDates } from "../../server/features/assistants/memory-flushes.js";

const run = "95e977b6-0ee8-4bc0-a310-5a2cf14f5c17";
const agentId = "ap-member";
const sessionKey = `agent:${agentId}:internal-session-effects:${run}-21a903bbd7325dca`;
const [today] = flushDates(Date.now());

// A bridge whose one reported flush interrupts a turn of `parent` with `origin`.
function bridge(parent, origin, noted = []) {
  const attempt = { id: run, runtimeRunId: run, requestId: "request" };
  return {
    now: () => Date.now(),
    warn: () => {},
    assistants: {
      memoryFlushes: {
        active: () => [{ sessionKey: "member-session", runId: run }],
        pin: () => true,
      },
      ledger: { getRequest: () => ({ conversationId: "chat" }) },
    },
    noteShared: (key, conversationId) => noted.push([key, conversationId]),
    bound: () => [attempt],
    turn: () => ({ attempt, parent, origin, current: true }),
    routineWrite: () => false,
  };
}
const input = { agentId, sessionKey, toolName: "write", path: today, runId: run };
const member = {
  runtimeAgentId: agentId,
  teamMemberId: "m",
  lifetime: "task",
  inherited: { capabilities: {}, skills: [], shell: "off", ssh: false },
};

test("a task member's flush writes its own day note in a turn its lead gave it", () => {
  assert.equal(flushWrite(bridge(member, { kind: "team-member" }), input), true);
  assert.equal(flushWrite(bridge(member, { kind: "lead-request" }), input), true);
});

test("a permanent agent's delegated turn still never flushes", () => {
  const permanent = { runtimeAgentId: agentId, teamMemberId: "m", lifetime: "permanent" };
  assert.equal(flushWrite(bridge(permanent, { kind: "lead-request" }), input), false);
  assert.equal(flushWrite(bridge(permanent, { kind: "owner" }), input), true);
});

test("a memory step takes OpenClaw's flush on its own agent and on a shared one", () => {
  const noted = [];
  const own = { runtimeAgentId: agentId };
  assert.equal(flushWrite(bridge(own, { kind: "memory-step" }, noted), input), true);
  assert.deepEqual(noted, [], "an own agent's flush leaves no note");
  const shared = { runtimeAgentId: agentId, userAccess: { mode: "shared" } };
  assert.equal(flushWrite(bridge(shared, { kind: "memory-step" }, noted), input), true);
  // The shared memory takes it like a saved write, noted in the flushing chat.
  assert.deepEqual(noted, [[`${run}:shared-write`, "chat"]]);
  assert.equal(flushWrite(bridge(own, { kind: "routine" }), input), false);
});
