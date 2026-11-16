import {
  emptyContext,
  list,
  tokens,
  timestamp,
  putShell,
} from "./observability-values.js";
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

/** Shells as the browser sees them: no file paths, and no live state of a dead session. */
function normalizeShells(value, session) {
  const shells = new Map();
  // Through putShell, so every limit holds for saved snapshots as well.
  for (const raw of list(value)) putShell(shells, raw?.id, raw);
  return [...shells.values()].map((entry) => {
    const { id, command, status, updatedAt, exitCode, startedAt, description } = entry;
    return {
      id,
      command,
      ...(description ? { description } : {}),
      status: session?.status !== "running" && status === "running" ? "unknown" : status,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(startedAt ? { startedAt } : {}),
      updatedAt,
      ...(typeof entry.ownerAgentId === "string"
        ? { ownerAgentId: entry.ownerAgentId }
        : {}),
      canStop: false,
      hasOutput: false,
    };
  });
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
  // Claude prices provider (gateway) models with its own table, so its CLI exit
  // cost is no cost of a provider session.
  const cliExitCost =
    session?.provider && value?.totals?.cost?.scope === "cli-exit-incl-subagents";
  const totals = normalizeTotals(
    cliExitCost ? { ...value.totals, cost: null } : value?.totals,
  );
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
      canStop: false,
      hasTranscript: false,
    })),
    shells: normalizeShells(value?.shells, session),
    stopNotes: [],
    stale: stale || Boolean(value?.stale),
  };
}
