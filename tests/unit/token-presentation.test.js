import test from "node:test";
import assert from "node:assert/strict";
import { setLanguage } from "../../web/lib/i18n/index.js";
import {
  formatTokens,
  formatUsd,
  formatDuration,
  windowLabel,
  usageSummary,
  lowerBoundShown,
  usedPercent,
  observedAgent,
  totalsRows,
  currentBuckets,
} from "../../web/features/chat/token-presentation.js";

const nbsp = " ";

test("token, cost, duration and window formats follow the language", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("en", { persist: false });
  assert.equal(formatTokens(12400), "12.4K");
  assert.equal(formatTokens(1200000), "1.2M");
  assert.equal(formatTokens(null), null);
  assert.equal(formatTokens(-1), null);
  assert.equal(formatUsd(1.25), "$1.25");
  assert.equal(formatUsd(0.0042), "$0.0042");
  assert.equal(formatUsd(0), "$0.00");
  assert.equal(formatUsd(-1), null);
  assert.equal(formatDuration(92000), "1m 32s");
  assert.equal(formatDuration(4000), "4s");
  assert.equal(formatDuration(3720000), "1h 2m");
  assert.equal(windowLabel(300), "5 h");
  assert.equal(windowLabel(10080), "7 days");
  assert.equal(windowLabel(1440), "1 day");
  assert.equal(windowLabel(45), "45 min");
  setLanguage("de", { persist: false });
  assert.equal(formatTokens(12400), "12.400");
  assert.equal(formatTokens(1200000), `1,2${nbsp}Mio.`);
  assert.equal(formatUsd(12.5), `12,50${nbsp}$`);
  assert.equal(formatDuration(92000), "1 min 32 s");
  assert.equal(windowLabel(10080), "7 Tage");
});

test("subagent usage shows tokens without cache reads and the cache reads apart", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  const usage = {
    totalTokens: 7_811_000,
    cacheReadTokens: 7_600_000,
    outputTokens: 20_000,
    outputIsLowerBound: true,
    durationMs: 92000,
  };
  setLanguage("en", { persist: false });
  assert.equal(usageSummary(usage), "211K tokens · 7.6M from cache · 1m 32s");
  assert.equal(
    usageSummary({ totalTokens: 1000, cacheReadTokens: 0 }),
    "1K tokens",
    "no cache reads, no cache part",
  );
  // Output dominates the tokens shown, so they are a lower bound.
  assert.equal(
    usageSummary({ ...usage, outputTokens: 150_000, durationMs: null }),
    "≥211K tokens · 7.6M from cache",
  );
  assert.equal(
    usageSummary({ totalTokens: 7_600_000, cacheReadTokens: 7_600_000 }),
    "7.6M from cache",
  );
  setLanguage("de", { persist: false });
  assert.equal(
    usageSummary({ totalTokens: 7_600_000, cacheReadTokens: 7_600_000 }),
    `7,6${nbsp}Mio. aus Cache`,
  );
  assert.equal(
    usageSummary(usage),
    `211.000 Tokens · 7,6${nbsp}Mio. aus Cache · 1 min 32 s`,
  );
});

test("usage summaries show a lower bound only when output dominates", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("en", { persist: false });
  assert.equal(
    usageSummary({
      totalTokens: 12400,
      outputTokens: 400,
      outputIsLowerBound: true,
      durationMs: 92000,
    }),
    "12.4K tokens · 1m 32s",
  );
  assert.equal(
    usageSummary({ totalTokens: 1000, outputTokens: 600, outputIsLowerBound: true }),
    "≥1K tokens",
  );
  assert.equal(usageSummary({ totalTokens: null, durationMs: 5000 }), "5s");
  assert.equal(usageSummary(null), null);
  assert.equal(
    lowerBoundShown({ totalTokens: 1000, outputTokens: 600, outputIsLowerBound: false }),
    false,
  );
  assert.equal(usedPercent({ remainingPercent: 41 }), 59);
  assert.equal(usedPercent({ remainingPercent: null }), null);
  const agents = [
    { id: "agentreview01", usage: { totalTokens: 1 } },
    { id: "agentx", toolUseId: "toolu_x" },
  ];
  assert.equal(
    observedAgent({ id: "toolu_review", subagent: { agentId: "agentreview01" } }, agents)
      .id,
    "agentreview01",
  );
  assert.equal(observedAgent({ id: "toolu_x", subagent: {} }, agents).id, "agentx");
  assert.equal(observedAgent({ id: "toolu_none", subagent: {} }, agents), null);
});

test("Codex reasoning is a sub-row of output; OpenCode keeps a separate row", (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  const totals = (source) => ({
    inputTokens: 900,
    outputTokens: 100,
    cacheReadTokens: 50,
    cacheWriteTokens: null,
    reasoningTokens: 40,
    totalTokens: 1000,
    source,
  });
  const rows = (source) =>
    totalsRows(totals(source)).map((row) => [row.label, row.value, row.sub]);
  setLanguage("en", { persist: false });
  assert.deepEqual(rows("codex-thread"), [
    ["Input (incl. cached)", 900, false],
    ["Output", 100, false],
    ["of which reasoning", 40, true],
    ["Cache read", 50, false],
    ["Total", 1000, false],
  ]);
  assert.deepEqual(rows("opencode-session"), [
    ["Input", 900, false],
    ["Output", 100, false],
    ["Cache read", 50, false],
    ["Reasoning", 40, false],
    ["Total", 1000, false],
  ]);
  setLanguage("de", { persist: false });
  assert.equal(totalsRows(totals("codex-process"))[2].label, "davon Reasoning");
});

test("limit windows past their reset and buckets left empty are hidden", () => {
  const now = 1_000_000;
  const window = (resetsAt) => ({ windowMinutes: 300, usedPercent: 5, resetsAt });
  const limits = {
    buckets: [
      { limitId: "a", windows: [window(now - 1), window(now + 1), window(null)] },
      { limitId: "b", windows: [window(now)], credits: null },
      {
        limitId: "c",
        windows: [window(now - 5)],
        credits: { hasCredits: false, unlimited: true, balance: null },
      },
    ],
  };
  const buckets = currentBuckets(limits, now);
  assert.deepEqual(
    buckets.map((bucket) => [bucket.limitId, bucket.windows.length]),
    [
      ["a", 2],
      ["c", 0],
    ],
  );
  assert.deepEqual(currentBuckets(null, now), []);
});
