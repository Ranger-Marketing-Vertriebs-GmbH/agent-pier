import test from "node:test";
import assert from "node:assert/strict";
import {
  AgentLoopGuard,
  loopGuard,
  loopGuardCaps,
} from "../../server/features/assistants/agent-loop-guard.js";
import { toolError } from "../../server/features/assistants/tool-errors.js";

// AGENTPIER-276: one loop guard per agent replaces nine overlapping rate caps.
test("the guard counts an agent's actions in a rolling window, per agent", () => {
  let now = 0;
  const guard = new AgentLoopGuard({
    now: () => now,
    caps: { actions: 3, windowMs: 1000 },
  });
  for (let n = 0; n < 3; n++) guard.take("a");
  let refusal;
  assert.throws(
    () => guard.take("a"),
    (error) => {
      refusal = error;
      return error.key === "agentLoopLimit" && error.status === 429;
    },
  );
  assert.equal(toolError(refusal).code, "AGENT_LOOP_LIMIT");
  assert.match(toolError(refusal).reason, /Do not retry/);
  // Another agent has its own count; the window rolls on.
  guard.take("b");
  now = 1000;
  guard.take("a");
});

test("the shipped guard is generous and one per service", () => {
  assert.deepEqual(loopGuardCaps, { actions: 60, windowMs: 600000 });
  const owner = {};
  assert.equal(loopGuard(owner), loopGuard(owner));
  assert.notEqual(loopGuard(owner), loopGuard({}));
});
