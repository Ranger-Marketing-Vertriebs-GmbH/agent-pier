import test from "node:test";
import assert from "node:assert/strict";
import {
  subagentRowStatus,
  subagentHeading,
} from "../../web/features/chat/subagent-presentation.js";

const row = (status, agentId = "agent1") => ({
  id: "toolu_1",
  role: "tool",
  status,
  subagent: { description: "Review", type: "general-purpose", status, agentId },
});

test("a frozen running row follows the observed state of its agent while live", () => {
  assert.equal(
    subagentRowStatus(row("running"), [{ id: "agent1", status: "completed" }], true),
    "completed",
  );
  assert.equal(
    subagentRowStatus(row("running"), [{ id: "agent1", status: "failed" }], true),
    "failed",
  );
  assert.equal(
    subagentRowStatus(row("running"), [{ id: "agent1", status: "running" }], true),
    "running",
  );
  // An agent the observer does not know is never reported as working.
  assert.equal(subagentRowStatus(row("running"), [], true), "unknown");
  assert.equal(subagentRowStatus(row("completed"), [], true), "completed");
  // Saved or stale data never shows a working agent, whatever the observer says.
  assert.equal(
    subagentRowStatus(row("running"), [{ id: "agent1", status: "running" }], false),
    "unknown",
  );
  assert.equal(subagentRowStatus(row("completed"), [], false), "completed");
  // A foreground call before its launch result has no agent id yet.
  assert.equal(subagentRowStatus(row("running", null), [], true), "running");
});

test("the heading counts listed and working subagents", () => {
  const running = { id: "a", status: "running" };
  const done = { id: "b", status: "completed" };
  assert.match(subagentHeading([running]), /\(1\)/);
  assert.match(subagentHeading([running, done]), /\(2 · 1/);
  assert.match(subagentHeading([done]), /\(1\)/);
});
