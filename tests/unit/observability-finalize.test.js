import test from "node:test";
import assert from "node:assert/strict";
import { finalizeObservability } from "../../server/features/chat/chat-observability.js";
import { assumedClaudeWindow } from "../../server/features/chat/context-window.js";
import {
  codexRateLimit,
  normalizeLimits,
} from "../../server/features/chat/rate-limits.js";

const claude = (context, extra = {}) => ({
  context: {
    usedTokens: null,
    limitTokens: null,
    remainingPercent: null,
    source: null,
    limitSource: null,
    observedAt: null,
    modelId: null,
    ...context,
  },
  subagents: [],
  ...extra,
});
const firstParty = { status: "running", tool: "claude" };

test("model table assumes 1M for native 1M Claude models and 200k otherwise", () => {
  for (const id of [
    "claude-opus-4-6",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-opus-5-5",
    "claude-sonnet-4-6",
    "claude-sonnet-5",
    "claude-sonnet-5-5",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-mythos",
    "claude-opus-5-5[1m]",
  ])
    assert.equal(assumedClaudeWindow(id), 1000000, id);
  for (const id of [
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-sonnet-4-5-20250929",
    "claude-opus-4-1",
    "claude-future-9",
  ])
    assert.equal(assumedClaudeWindow(id), 200000, id);
  for (const id of [null, "", "opus", "gpt-5", "<synthetic>"])
    assert.equal(assumedClaudeWindow(id), null, String(id));
});

test("first-party Claude sessions get an assumed window that is dropped when exceeded", () => {
  const assumed = finalizeObservability(
    claude({
      usedTokens: 250000,
      source: "last-api-request",
      modelId: "claude-opus-5-5",
    }),
    firstParty,
  ).context;
  assert.deepEqual(
    [assumed.limitTokens, assumed.limitSource, assumed.remainingPercent],
    [1000000, "assumed-model", 75],
  );
  const fallback = finalizeObservability(claude({}), {
    ...firstParty,
    nativeModelId: "claude-sonnet-5[1m]",
  }).context;
  assert.deepEqual([fallback.limitTokens, fallback.remainingPercent], [1000000, null]);
  assert.equal(assumedClaudeWindow("claude-sonnet-4-5[1m]"), 1000000);
  const beta = (modelId) =>
    finalizeObservability(claude({ modelId }), {
      ...firstParty,
      nativeModelId: "claude-sonnet-4-5[1m]",
    }).context.limitTokens;
  assert.equal(beta("claude-sonnet-4-5-20250929"), 1000000);
  assert.equal(beta("claude-haiku-4-5-20251001"), 200000);
  const alias = (nativeModelId, modelId) =>
    finalizeObservability(claude({ modelId }), { ...firstParty, nativeModelId }).context
      .limitTokens;
  assert.equal(alias("sonnet[1m]", "claude-sonnet-4-5-20250929"), 1000000);
  assert.equal(alias("sonnet[1m]", "claude-haiku-4-5-20251001"), 200000);
  assert.equal(alias("sonnet", "claude-sonnet-4-5-20250929"), 200000);
  const dropped = finalizeObservability(
    claude({
      usedTokens: 250000,
      source: "last-api-request",
      modelId: "claude-haiku-4-5",
    }),
    firstParty,
  ).context;
  assert.deepEqual(
    [dropped.limitTokens, dropped.limitSource, dropped.remainingPercent],
    [null, null, null],
  );
});

test("provider sessions, other CLIs and reported windows never use the model table", () => {
  const used = { usedTokens: 10, source: "last-api-request", modelId: "claude-opus-5-5" };
  assert.equal(
    finalizeObservability(claude(used), {
      ...firstParty,
      provider: { contextStatus: "native-catalog" },
    }).context.limitTokens,
    null,
  );
  assert.equal(
    finalizeObservability(claude(used), { status: "running", tool: "opencode" }).context
      .limitTokens,
    null,
  );
  const configured = finalizeObservability(claude({ ...used, modelId: "fixture" }), {
    ...firstParty,
    provider: {
      contextStatus: "configured",
      assumedContextTokens: 64000,
      requestedModelId: "fixture",
    },
  }).context;
  assert.deepEqual(
    [configured.limitTokens, configured.limitSource],
    [64000, "configured"],
  );
  const native = finalizeObservability(
    claude({ ...used, limitTokens: 400000, limitSource: "native" }),
    firstParty,
  ).context;
  assert.deepEqual([native.limitTokens, native.limitSource], [400000, "native"]);
});

test("a saved assumed window is re-evaluated on every finalize", () => {
  const saved = finalizeObservability(
    claude({
      usedTokens: 300000,
      source: "last-api-request",
      modelId: "claude-opus-5-5",
    }),
    firstParty,
  );
  const switched = finalizeObservability(
    { ...saved, context: { ...saved.context, modelId: "claude-haiku-4-5" } },
    firstParty,
    { stale: true },
  );
  assert.deepEqual(
    [
      switched.context.limitTokens,
      switched.context.limitSource,
      switched.context.remainingPercent,
    ],
    [null, null, null],
  );
  assert.equal(switched.stale, true);
  assert.deepEqual(finalizeObservability(saved, firstParty).context, saved.context);
});

test("compaction keeps only the post-compaction conversation size and no percentage", () => {
  const value = finalizeObservability(
    claude({
      modelId: "claude-opus-5-5",
      compaction: { conversationTokens: 41200, observedAt: "2026-10-01T10:00:00Z" },
    }),
    firstParty,
  ).context;
  assert.deepEqual(value.compaction, {
    conversationTokens: 41200,
    observedAt: "2026-10-01T10:00:00.000Z",
  });
  assert.equal(value.usedTokens, null);
  assert.equal(value.remainingPercent, null);
  assert.equal(
    finalizeObservability(claude({ compaction: { conversationTokens: "x" } }), firstParty)
      .context.compaction,
    null,
  );
});

test("Codex rate limits keep buckets per limit id, drop past windows and keep the balance string", () => {
  const now = Date.parse("2026-10-01T10:00:00Z");
  const future = now / 1000 + 3600,
    past = now / 1000 - 60;
  const codex = codexRateLimit({
    limit_id: "codex",
    limit_name: null,
    primary: { used_percent: 42.5, window_minutes: 10080, resets_at: future },
    secondary: null,
    credits: { has_credits: true, unlimited: false, balance: "12.5000" },
    individual_limit: null,
    plan_type: "pro",
  });
  assert.deepEqual(codex, {
    limitId: "codex",
    limitName: null,
    plan: "pro",
    windows: [{ windowMinutes: 10080, usedPercent: 42.5, resetsAt: future * 1000 }],
    credits: { hasCredits: true, unlimited: false, balance: "12.5000" },
  });
  const spark = codexRateLimit({
    limit_id: "codex_bengalfox",
    limit_name: "GPT-5.3-Codex-Spark",
    primary: { used_percent: 130, window_minutes: 300, resets_at: past },
    secondary: { used_percent: 7, window_minutes: 10080, resets_at: future },
    credits: null,
  });
  const premium = codexRateLimit({ limit_id: "premium", primary: null, secondary: null });
  const limits = normalizeLimits(
    { buckets: [codex, spark, premium], observedAt: "2026-10-01T09:59:00Z" },
    now,
  );
  assert.deepEqual(
    limits.buckets.map((bucket) => [
      bucket.limitId,
      bucket.windows.map((w) => w.windowMinutes),
    ]),
    [
      ["codex", [10080]],
      ["codex_bengalfox", [10080]],
    ],
  );
  assert.equal(limits.buckets[0].credits.balance, "12.5000");
  assert.equal(
    codexRateLimit({ limit_id: "x", primary: { used_percent: Number.NaN } }).windows
      .length,
    0,
  );
  assert.equal(
    codexRateLimit({
      limit_id: "x",
      primary: { used_percent: 130, window_minutes: 300, resets_at: future },
    }).windows[0].usedPercent,
    100,
  );
  assert.equal(normalizeLimits({ buckets: [] }, now), null);
  assert.equal(
    finalizeObservability({ limits: { buckets: [spark] } }, firstParty, { now }).limits
      .buckets[0].windows.length,
    1,
  );
});

test("finalize merges subagent usage into rows and totals and drops the internal field", () => {
  const value = finalizeObservability(
    {
      context: {},
      subagents: [
        {
          id: "agentreview01",
          name: "",
          task: "",
          status: "completed",
          usage: { toolUses: 4, durationMs: 61000 },
        },
      ],
      totals: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: null,
        totalTokens: 15,
        outputIsLowerBound: true,
        source: "claude-transcript",
      },
      subagentUsage: {
        agents: {
          agentreview01: {
            inputTokens: 1,
            outputTokens: 2,
            cacheReadTokens: 3,
            cacheWriteTokens: 4,
            reasoningTokens: null,
            totalTokens: 10,
            outputIsLowerBound: true,
          },
        },
        toolUses: {},
        workflow: null,
        unavailable: 0,
      },
    },
    firstParty,
  );
  assert.equal(Object.hasOwn(value, "subagentUsage"), false);
  assert.equal(value.totals.totalTokens, 15);
  assert.equal(value.totals.subagents.totalTokens, 10);
  assert.deepEqual(
    [value.subagents[0].usage.totalTokens, value.subagents[0].usage.durationMs],
    [10, 61000],
  );
  const saved = finalizeObservability(JSON.parse(JSON.stringify(value)), firstParty, {
    stale: true,
  });
  assert.deepEqual(saved.totals, value.totals);
  assert.deepEqual(saved.subagents[0].usage, value.subagents[0].usage);
  assert.deepEqual(finalizeObservability(null, firstParty).totals, null);
});

test("CLI exit cost is dropped for provider sessions and kept for first-party Claude", () => {
  const value = {
    totals: {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cost: { usd: 1.5, scope: "cli-exit-incl-subagents" },
    },
  };
  assert.deepEqual(finalizeObservability(value, firstParty).totals.cost, {
    usd: 1.5,
    scope: "cli-exit-incl-subagents",
  });
  const provider = { ...firstParty, provider: { modelId: "glm-5" } };
  const dropped = finalizeObservability(value, provider).totals;
  assert.deepEqual([dropped.cost, dropped.totalTokens], [null, 15]);
  const costOnly = { totals: { cost: value.totals.cost } };
  assert.equal(finalizeObservability(costOnly, provider).totals, null);
  const session = { totals: { ...value.totals, cost: { usd: 2, scope: "session" } } };
  assert.equal(finalizeObservability(session, provider).totals.cost.usd, 2);
});
