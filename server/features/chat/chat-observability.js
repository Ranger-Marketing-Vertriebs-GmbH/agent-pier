import { emptyContext, list, tokens, timestamp } from "./observability-values.js";
import { applyContextWindow } from "./context-window.js";
import {
  normalizeTotals,
  normalizeSubagentUsage,
  subagentTotals,
  agentUsage,
} from "./token-usage.js";
import { normalizeLimits } from "./rate-limits.js";
export { observeClaude } from "./claude-observability.js";
export { observeCodex } from "./codex-observability.js";
export { observeOpenCode } from "./opencode-observability.js";

function compaction(value) {
  const conversationTokens = tokens(value?.conversationTokens);
  return conversationTokens === null
    ? null
    : { conversationTokens, observedAt: timestamp(value.observedAt) };
}

/** The single merge point for live pages and saved snapshots. */
export function finalizeObservability(
  value,
  session,
  { stale = false, now = Date.now() } = {},
) {
  const base = { ...emptyContext(), ...value?.context };
  const context = applyContextWindow(
    { ...base, compaction: compaction(base.compaction) },
    session,
  );
  const usage = normalizeSubagentUsage(value?.subagentUsage);
  const totals = normalizeTotals(value?.totals);
  if (totals && usage) totals.subagents = subagentTotals(usage);
  return {
    context,
    totals,
    limits: normalizeLimits(value?.limits, now),
    subagents: list(value?.subagents).map((agent) => ({
      ...agent,
      ...(session?.status !== "running" && agent.status === "running"
        ? { status: "unknown" }
        : {}),
      usage: agentUsage(agent, usage),
    })),
    stale: stale || Boolean(value?.stale),
  };
}
