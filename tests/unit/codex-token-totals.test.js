import test from "node:test";
import assert from "node:assert/strict";
import { observeCodex } from "../../server/features/chat/codex-observability.js";

const usage = (input, cached, output, reasoning) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: reasoning,
  total_tokens: input + output,
});
const usageRecord = (thread, at, value) => ({
  timestamp: at,
  ordinal: 1,
  type: "token_usage_record",
  payload: {
    thread_id: thread,
    turn_id: "turn1",
    session_id: "session1",
    root_turn_id: "turn1",
    response_id: "resp1",
    usage: value,
    turn_token_usage: value,
    thread_token_usage: value,
  },
});
const tokenCount = (at, total, rateLimits = null) => ({
  timestamp: at,
  ordinal: 2,
  type: "event_msg",
  payload: {
    type: "token_count",
    info: total
      ? {
          total_token_usage: total,
          last_token_usage: total,
          model_context_window: 272000,
        }
      : null,
    rate_limits: rateLimits,
  },
});

test("Codex totals prefer the per-thread record over a reset process total", () => {
  const result = observeCodex({ id: "thread-parent" }, [
    usageRecord("thread-parent", "2026-10-01T10:00:00Z", usage(50000, 40000, 2000, 800)),
    tokenCount("2026-10-01T10:00:01Z", usage(900, 0, 100, 10)),
  ]);
  assert.deepEqual(
    [
      result.totals.inputTokens,
      result.totals.cacheReadTokens,
      result.totals.outputTokens,
      result.totals.reasoningTokens,
      result.totals.totalTokens,
      result.totals.source,
      result.totals.cost,
    ],
    [50000, 40000, 2000, 800, 52000, "codex-thread", null],
  );
  const fallback = observeCodex({ id: "thread-parent" }, [
    tokenCount("2026-10-01T10:00:01Z", usage(900, 0, 100, 10)),
  ]);
  assert.deepEqual(
    [fallback.totals.totalTokens, fallback.totals.source],
    [1000, "codex-process"],
  );
  assert.equal(observeCodex({}, []).totals, null);
});

test("records of another thread and compaction snapshots never replace thread totals", () => {
  const result = observeCodex({ id: "thread-parent" }, [
    usageRecord("thread-parent", "2026-10-01T10:00:00Z", usage(1000, 0, 10, 0)),
    usageRecord("thread-child", "2026-10-01T10:00:01Z", usage(99999, 0, 1, 0)),
    {
      timestamp: "2026-10-01T10:00:02Z",
      type: "compacted",
      payload: {
        message: "",
        latest_token_usage_record: {
          thread_id: "thread-parent",
          thread_token_usage: usage(5, 0, 5, 0),
        },
      },
    },
  ]);
  assert.equal(result.totals.totalTokens, 1010);
  assert.equal(result.totals.observedAt, "2026-10-01T10:00:00.000Z");
});

test("Codex rate limits keep the latest snapshot per limit id", () => {
  const future = Math.floor(Date.now() / 1000) + 7200;
  const result = observeCodex({}, [
    tokenCount("2026-10-01T10:00:00Z", null, {
      limit_id: "codex",
      limit_name: null,
      primary: { used_percent: 10, window_minutes: 10080, resets_at: future },
      secondary: null,
      credits: null,
      plan_type: "pro",
    }),
    tokenCount("2026-10-01T10:00:01Z", null, {
      limit_id: "codex_bengalfox",
      limit_name: "GPT-5.3-Codex-Spark",
      primary: { used_percent: 30, window_minutes: 300, resets_at: future },
      secondary: { used_percent: 5, window_minutes: 10080, resets_at: future },
      credits: null,
    }),
    tokenCount("2026-10-01T10:00:02Z", null, {
      limit_id: "codex",
      primary: { used_percent: 12, window_minutes: 10080, resets_at: future },
      secondary: null,
      credits: null,
      plan_type: "pro",
    }),
  ]);
  assert.deepEqual(
    result.limits.buckets.map((bucket) => [
      bucket.limitId,
      bucket.windows.map((window) => window.usedPercent),
    ]),
    [
      ["codex_bengalfox", [30, 5]],
      ["codex", [12]],
    ],
  );
  assert.equal(result.limits.observedAt, "2026-10-01T10:00:02.000Z");
  assert.equal(result.context.usedTokens, null);
});
