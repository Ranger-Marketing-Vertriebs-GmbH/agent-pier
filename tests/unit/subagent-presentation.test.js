import test from "node:test";
import assert from "node:assert/strict";
import {
  subagentRowStatus,
  visibleSubagents,
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

test("finished subagents are listed newest first by their update time", () => {
  const agents = [
    { id: "late", status: "completed", updatedAt: "2026-09-07T10:00:09Z" },
    { id: "work", status: "running", updatedAt: "2026-09-07T10:00:01Z" },
    ...Array.from({ length: 6 }, (_, i) => ({
      id: `old${i}`,
      status: i === 2 ? "failed" : "completed",
      updatedAt: `2026-09-07T10:00:0${i}Z`,
    })),
  ];
  assert.deepEqual(
    visibleSubagents(agents, true).map((agent) => agent.id),
    ["work", "late", "old5", "old4", "old3", "old2"],
  );
  assert.deepEqual(
    visibleSubagents(agents, false).map((agent) => agent.id),
    ["late", "old5", "old4", "old3", "old2"],
  );
});

test("the heading counts listed and working subagents", () => {
  const running = { id: "a", status: "running" };
  const done = { id: "b", status: "completed" };
  assert.match(subagentHeading([running]), /\(1\)/);
  assert.match(subagentHeading([running, done]), /\(2 · 1/);
  assert.match(subagentHeading([done]), /\(1\)/);
});
