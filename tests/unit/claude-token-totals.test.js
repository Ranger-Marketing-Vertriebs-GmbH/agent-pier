import test from "node:test";
import assert from "node:assert/strict";
import { observeClaude } from "../../server/features/chat/claude-observability.js";
import { subagentEvent } from "../../server/features/chat/claude-subagents.js";

const assistant = (id, output, stop, at) => ({
  type: "assistant",
  timestamp: at,
  message: {
    id,
    model: "claude-opus-5-5",
    role: "assistant",
    stop_reason: stop,
    content: [],
    usage: {
      input_tokens: 4,
      cache_creation_input_tokens: 600,
      cache_read_input_tokens: 20000,
      output_tokens: output,
      output_tokens_details: { thinking_tokens: 9 },
      service_tier: "standard",
      iterations: [],
      speed: "standard",
      fallback_credit: null,
      server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    },
  },
});
const costState = (usd) => ({
  type: "cost-state",
  sessionId: "native",
  totalCostUSD: usd,
  totalAPIDuration: 1,
  totalDuration: 2,
  modelUsage: {},
  hasUnknownModelCost: false,
});
const notificationText =
  "<task-notification>\n<task-id>agentreview01</task-id>\n<tool-use-id>toolu_review</tool-use-id>\n<status>completed</status>\n<summary>Agent finished</summary>\n<usage><subagent_tokens>91234</subagent_tokens><tool_uses>12</tool_uses><duration_ms>92000</duration_ms></usage>\n</task-notification>";

test("Claude totals dedupe per message id, keep output as a lower bound and never report reasoning", () => {
  const result = observeClaude([
    assistant("msg_1", 1, null, "2026-10-01T10:00:00Z"),
    assistant("msg_1", 300, "end_turn", "2026-10-01T10:00:01Z"),
    assistant("msg_2", 2, null, "2026-10-01T10:00:02Z"),
  ]);
  assert.deepEqual(
    [
      result.totals.inputTokens,
      result.totals.cacheWriteTokens,
      result.totals.cacheReadTokens,
      result.totals.outputTokens,
      result.totals.totalTokens,
    ],
    [8, 1200, 40000, 302, 41510],
  );
  assert.equal(result.totals.reasoningTokens, null);
  assert.equal(result.totals.outputIsLowerBound, true);
  assert.equal(result.totals.cost, null);
  assert.equal(observeClaude([]).totals, null);
});

test("Claude cost is shown only while no assistant record follows the latest cost-state", () => {
  const base = [assistant("msg_1", 10, "end_turn", "2026-10-01T10:00:00Z")];
  assert.deepEqual(observeClaude([...base, costState(1.2345)]).totals.cost, {
    usd: 1.2345,
    scope: "cli-exit-incl-subagents",
  });
  assert.equal(
    observeClaude([
      ...base,
      costState(1.2345),
      assistant("msg_2", 3, null, "2026-10-01T11:00:00Z"),
    ]).totals.cost,
    null,
  );
  assert.equal(
    observeClaude([
      ...base,
      costState(1),
      { type: "user", message: { role: "user", content: "resume" } },
      costState(2),
    ]).totals.cost.usd,
    2,
  );
  assert.equal(observeClaude([...base, costState(-1)]).totals.cost, null);
  // Claude flags estimates for models without a price (gateway models).
  assert.equal(
    observeClaude([...base, { ...costState(4), hasUnknownModelCost: true }]).totals.cost,
    null,
  );
  assert.equal(observeClaude([...base, costState("3")]).totals.cost, null);
  // The history index turns API errors into assistant records; they are no reply.
  assert.equal(
    observeClaude([
      ...base,
      costState(4),
      {
        type: "assistant",
        isApiErrorMessage: true,
        message: { role: "assistant", content: "Overloaded" },
      },
    ]).totals.cost.usd,
    4,
  );
});

test("compaction stores the post-compaction conversation size until the next usage", () => {
  const compact = {
    type: "system",
    subtype: "compact_boundary",
    timestamp: "2026-10-01T10:05:00Z",
    compactMetadata: {
      trigger: "auto",
      preTokens: 900000,
      postTokens: 41200,
      durationMs: 1,
    },
  };
  const first = assistant("msg_1", 10, "end_turn", "2026-10-01T10:00:00Z");
  const compacted = observeClaude([first, compact]).context;
  assert.equal(compacted.usedTokens, null);
  assert.deepEqual(compacted.compaction, {
    conversationTokens: 41200,
    observedAt: "2026-10-01T10:05:00.000Z",
  });
  const resumed = observeClaude([
    first,
    compact,
    assistant("msg_2", 10, null, "2026-10-01T10:06:00Z"),
  ]).context;
  assert.equal(resumed.compaction, null);
  assert.equal(resumed.usedTokens, 20604);
  assert.equal(
    observeClaude([{ ...compact, compactMetadata: {} }]).context.compaction,
    null,
  );
});

test("task notifications give duration and tool uses, never tokens", () => {
  const notification = {
    type: "user",
    origin: { kind: "task-notification", producer: "session-task" },
    message: { role: "user", content: notificationText },
  };
  const event = subagentEvent(notification);
  assert.deepEqual([event.durationMs, event.toolUses], [92000, 12]);
  const agent = observeClaude([
    {
      type: "assistant",
      message: {
        id: "msg_call",
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "toolu_review",
            name: "Agent",
            input: { description: "Review parser", subagent_type: "general-purpose" },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_review", content: "Launched." },
        ],
      },
      toolUseResult: {
        isAsync: true,
        status: "async_launched",
        agentId: "agentreview01",
      },
    },
    notification,
  ]).subagents.find((entry) => entry.id === "agentreview01");
  assert.deepEqual(agent.usage, { toolUses: 12, durationMs: 92000 });
  assert.equal(agent.toolUseId, "toolu_review");
  assert.equal(JSON.stringify(agent).includes("91234"), false);
});
