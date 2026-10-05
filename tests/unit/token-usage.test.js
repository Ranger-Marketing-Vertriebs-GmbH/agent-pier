import test from "node:test";
import assert from "node:assert/strict";
import {
  addTokens,
  totalsValue,
  normalizeTotals,
  createClaudeUsage,
  codexTotals,
  openCodeTotals,
  normalizeSubagentUsage,
  subagentTotals,
  agentUsage,
} from "../../server/features/chat/token-usage.js";

const message = (id, output, stop) => ({
  id,
  stop_reason: stop,
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 1000,
    output_tokens: output,
    output_tokens_details: { thinking_tokens: 4 },
    iterations: [],
    speed: "standard",
    fallback_credit: null,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  },
});

test("token sums are null when any part is unknown and never invent zero", () => {
  assert.equal(addTokens(1, 2, 3), 6);
  assert.equal(addTokens(1, null), null);
  assert.equal(addTokens(1, -1), null);
  assert.equal(addTokens(1, 1.5), null);
  assert.equal(totalsValue({}), null);
  assert.equal(totalsValue({ inputTokens: "12" }), null);
  const totals = totalsValue({ inputTokens: 0, cost: { usd: -1, scope: "session" } });
  assert.equal(totals.inputTokens, 0);
  assert.equal(totals.cost, null);
  assert.equal(totalsValue({ cost: { usd: 1, scope: "guess" } }), null);
});

test("Claude usage keeps the last record per message id and output is a lower bound", () => {
  const usage = createClaudeUsage();
  usage.add(message("msg_a", 1, null), "2026-10-01T10:00:00Z");
  usage.add(message("msg_a", 40, null), "2026-10-01T10:00:01Z");
  usage.add(message("msg_a", 250, "end_turn"), "2026-10-01T10:00:02Z");
  usage.add(message("msg_b", 3, null), "2026-10-01T10:00:03Z");
  const totals = usage.totals();
  assert.deepEqual(
    [
      totals.inputTokens,
      totals.cacheWriteTokens,
      totals.cacheReadTokens,
      totals.outputTokens,
      totals.reasoningTokens,
      totals.totalTokens,
    ],
    [20, 200, 2000, 253, null, 2473],
  );
  assert.equal(totals.outputIsLowerBound, true);
  assert.equal(totals.source, "claude-transcript");
  assert.equal(totals.observedAt, "2026-10-01T10:00:03.000Z");
  const final = createClaudeUsage();
  final.add(message("msg_c", 7, "tool_use"));
  assert.equal(final.totals().outputIsLowerBound, true);
  assert.equal(createClaudeUsage().totals(), null);
});

test("malformed Claude usage is skipped, not counted as zero", () => {
  const usage = createClaudeUsage();
  usage.add({
    id: "x",
    stop_reason: "end_turn",
    usage: { input_tokens: "5", output_tokens: 1 },
  });
  usage.add({
    id: "y",
    stop_reason: "end_turn",
    usage: { input_tokens: 5, cache_read_input_tokens: -2 },
  });
  assert.equal(usage.totals(), null);
  usage.add({
    id: "z",
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 2 },
  });
  assert.equal(usage.totals().totalTokens, 7);
});

test("Codex totals are taken as reported, reasoning stays a subset of output and cache writes stay unknown", () => {
  const totals = codexTotals(
    {
      input_tokens: 9000,
      cached_input_tokens: 6000,
      cache_write_input_tokens: 0,
      output_tokens: 700,
      reasoning_output_tokens: 300,
      total_tokens: 9700,
    },
    "codex-thread",
    "2026-10-01T10:00:00Z",
  );
  assert.deepEqual(
    [
      totals.inputTokens,
      totals.cacheReadTokens,
      totals.cacheWriteTokens,
      totals.outputTokens,
      totals.reasoningTokens,
      totals.totalTokens,
      totals.cost,
      totals.source,
      totals.outputIsLowerBound,
    ],
    [9000, 6000, null, 700, 300, 9700, null, "codex-thread", false],
  );
});

test("OpenCode totals add reasoning and both cache counts and carry real cost", () => {
  const totals = openCodeTotals(
    {
      cost: 0.4321,
      tokens_input: 100,
      tokens_output: 50,
      tokens_reasoning: 25,
      tokens_cache_read: 400,
      tokens_cache_write: 10,
    },
    1759312800000,
  );
  assert.equal(totals.totalTokens, 585);
  assert.deepEqual(totals.cost, { usd: 0.4321, scope: "session" });
  assert.equal(totals.observedAt, "2025-10-01T10:00:00.000Z");
  const partial = openCodeTotals({
    cost: null,
    tokens_input: 1,
    tokens_output: null,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
  });
  assert.equal(partial.totalTokens, null);
  assert.equal(partial.outputTokens, null);
  assert.equal(partial.cost, null);
});

test("subagent totals sum linked and workflow agents and keep prototype-like ids apart", () => {
  const file = (total) => ({
    inputTokens: 1,
    outputTokens: total - 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: null,
    totalTokens: total,
    outputIsLowerBound: true,
  });
  const usage = normalizeSubagentUsage({
    agents: { agentreview01: file(100), constructor: file(5) },
    toolUses: { toolu_review: "agentreview01" },
    workflow: { count: 2, usage: file(50) },
    unavailable: 0,
  });
  const totals = subagentTotals(usage);
  assert.equal(totals.count, 4);
  assert.equal(totals.totalTokens, 155);
  assert.equal(totals.reasoningTokens, null);
  assert.equal(totals.workflowAgents, 2);
  assert.equal(totals.outputIsLowerBound, true);
  assert.equal(agentUsage({ id: "toString" }, usage), null);
  assert.equal(
    agentUsage({ id: "unknown", toolUseId: "toolu_review" }, usage).totalTokens,
    100,
  );
  const merged = agentUsage(
    { id: "agentreview01", usage: { toolUses: 12, durationMs: 92000 } },
    usage,
  );
  assert.deepEqual(
    [merged.totalTokens, merged.toolUses, merged.durationMs],
    [100, 12, 92000],
  );
  const unread = agentUsage(
    { id: "agentnone", usage: { toolUses: 3, durationMs: 1000 } },
    usage,
  );
  assert.deepEqual([unread.totalTokens, unread.toolUses], [null, 3]);
  assert.equal(
    subagentTotals(normalizeSubagentUsage({ agents: {}, unavailable: 0 })),
    null,
  );
});

test("finalized totals survive a saved snapshot round trip unchanged", () => {
  const totals = totalsValue({
    inputTokens: 1,
    outputTokens: 2,
    cacheReadTokens: 3,
    cacheWriteTokens: 4,
    reasoningTokens: null,
    totalTokens: 10,
    outputIsLowerBound: true,
    cost: { usd: 0.005, scope: "cli-exit-incl-subagents" },
    source: "claude-transcript",
    observedAt: "2026-10-01T10:00:00Z",
  });
  totals.subagents = subagentTotals(
    normalizeSubagentUsage({
      agents: { agentreview01: { totalTokens: 9, outputTokens: 9 } },
      unavailable: 1,
    }),
  );
  assert.deepEqual(normalizeTotals(JSON.parse(JSON.stringify(totals))), totals);
});
