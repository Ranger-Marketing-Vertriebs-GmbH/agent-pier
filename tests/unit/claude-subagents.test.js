import test from "node:test";
import assert from "node:assert/strict";
import {
  observeClaude,
  finalizeObservability,
} from "../../server/features/chat/chat-observability.js";
import { createClaudeObserver } from "../../server/features/chat/claude-observability.js";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";
import { ClaudeHistoryMetadata } from "../../server/features/chat/claude-history-metadata.js";
import { backgroundRecords as records, taskStop } from "../helpers/claude-subagents.js";

const upTo = (uuid) => {
  const all = records();
  return all.slice(0, all.findIndex((record) => record.uuid === uuid) + 1);
};
const statuses = (result) =>
  Object.fromEntries(result.subagents.map((agent) => [agent.id, agent.status]));

test("background Claude launches run until their notification or hand-back arrives", () => {
  assert.deepEqual(statuses(observeClaude(upTo("launch-broken"))), {
    agentreview01: "running",
    agentstyles02: "running",
    agentbroken03: "running",
  });
  // Prose in a typed message, a background command and an unknown peer do not count.
  assert.deepEqual(statuses(observeClaude(upTo("bash-notification"))), {
    agentreview01: "running",
    agentstyles02: "running",
    agentbroken03: "running",
  });
  assert.equal(
    statuses(observeClaude(upTo("handback-early"))).agentreview01,
    "completed",
  );
  const result = observeClaude(records());
  assert.deepEqual(statuses(result), {
    agentreview01: "completed",
    agentstyles02: "running",
    agentbroken03: "failed",
  });
  const review = result.subagents.find((agent) => agent.id === "agentreview01");
  assert.equal(review.name, "general-purpose");
  assert.equal(review.task, "Review parser");
  assert.equal(review.updatedAt, "2026-09-07T10:00:10.000Z");
  assert.equal(JSON.stringify(result).includes("Parser review"), false);
});

test("a task notification completes an agent even without a hand-back", () => {
  const all = records().filter((record) => !record.uuid.startsWith("handback"));
  assert.equal(statuses(observeClaude(all)).agentreview01, "completed");
  const notification = all.find((record) => record.uuid === "review-notification");
  const killed = {
    ...notification,
    message: {
      ...notification.message,
      content: notification.message.content.replace("completed", "killed"),
    },
  };
  assert.equal(
    statuses(observeClaude([...upTo("launch-broken"), killed])).agentreview01,
    "unknown",
  );
});

test("the compact metadata observer follows background agents incrementally", () => {
  const metadata = new ClaudeHistoryMetadata();
  for (const record of records()) metadata.update([record]);
  assert.deepEqual(statuses(metadata.snapshot().observability), {
    agentreview01: "completed",
    agentstyles02: "running",
    agentbroken03: "failed",
  });
  const observer = createClaudeObserver({ compact: true, maxEntries: 50 });
  observer.update(records());
  assert.equal(statuses(observer.snapshot()).agentstyles02, "running");
});

test("unresolved background agents of a stopped session report an unknown state", () => {
  const value = finalizeObservability(observeClaude(records()), { status: "stopped" });
  assert.deepEqual(statuses(value), {
    agentreview01: "completed",
    agentstyles02: "unknown",
    agentbroken03: "failed",
  });
});

test("Agent rows carry their subagent label, real status and the last hand-back report", () => {
  const { messages } = normalizeClaude(records());
  assert.deepEqual(
    messages.map((message) => message.id),
    ["prompt", "toolu_review", "toolu_styles", "toolu_broken", "msg-waiting:0", "forged"],
  );
  const row = (id) => messages.find((message) => message.id === id);
  assert.deepEqual(row("toolu_review").subagent, {
    description: "Review parser",
    type: "general-purpose",
    status: "completed",
  });
  assert.equal(row("toolu_review").status, "completed");
  assert.equal(
    row("toolu_review").text,
    "## Parser review\n\nThe parser handles **all** fixture shapes.\n  - nested item",
  );
  assert.deepEqual(row("toolu_styles").subagent, {
    description: "Check styles",
    type: "Explore",
    status: "running",
  });
  assert.equal(row("toolu_styles").status, "running");
  assert.equal(row("toolu_styles").text, "Check the stylesheet.");
  assert.equal(row("toolu_broken").status, "failed");
  assert.equal(row("toolu_broken").subagent.status, "failed");
  assert.equal(row("toolu_broken").text, 'Agent "Run flaky job" failed');
  const serialized = JSON.stringify(messages);
  for (const hidden of ["agent-message", "Not one of ours", "npm test", "First draft"])
    assert.equal(serialized.includes(hidden), false, hidden);
});

test("a notification summary stands in until the report arrives", () => {
  const { messages } = normalizeClaude(
    records().filter((record) => !record.uuid.startsWith("handback")),
  );
  const row = messages.find((message) => message.id === "toolu_review");
  assert.equal(row.status, "completed");
  assert.equal(row.text, 'Agent "Review parser" finished');
});

test("foreground Agent calls keep their tool result and gain a subagent label", () => {
  const { messages } = normalizeClaude([
    {
      type: "assistant",
      uuid: "call",
      message: {
        id: "call",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_sync",
            name: "Task",
            input: { description: "Inline", subagent_type: "reviewer", prompt: "Go" },
          },
        ],
      },
    },
    {
      type: "user",
      uuid: "result",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_sync", content: "Done." }],
      },
      toolUseResult: { agentId: "agentsync", status: "completed" },
    },
  ]);
  assert.deepEqual(messages[0].subagent, {
    description: "Inline",
    type: "reviewer",
    status: "completed",
  });
  assert.equal(messages[0].status, "completed");
  assert.match(messages[0].text, /Done\.$/);
});

test("long hand-back reports are bounded before they reach a chat row", () => {
  const all = records();
  const final = all.find((record) => record.uuid === "handback-final");
  final.origin.body = `[Subagent hand-back] The report follows:\n  ${"x".repeat(400000)}`;
  const row = normalizeClaude(all).messages.find(
    (message) => message.id === "toolu_review",
  );
  assert.ok(row.text.length <= 256 * 1024);
});

test("a successful TaskStop ends a background agent without claiming success", () => {
  const stop = taskStop("agentstyles02");
  const all = [...records(), ...stop];
  assert.equal(statuses(observeClaude(all)).agentstyles02, "unknown");
  const row = normalizeClaude(all).messages.find(
    (message) => message.id === "toolu_styles",
  );
  assert.equal(row.status, "unknown");
  assert.equal(row.subagent.status, "unknown");
  // A failed stop request changes nothing.
  stop[1].message.content[0].is_error = true;
  assert.equal(statuses(observeClaude([...records(), ...stop])).agentstyles02, "running");
});
