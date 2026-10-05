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
