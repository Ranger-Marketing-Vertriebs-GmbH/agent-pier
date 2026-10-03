import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";

export const RECENT_SUBAGENTS = 5;

export const subagentStatus = (agent) =>
  ["running", "completed", "failed"].includes(agent?.status) ? agent.status : "unknown";

/** "Active subagents (n)" counts working agents; otherwise all listed ones. */
export function subagentHeading(subagents) {
  const running = subagents.filter((agent) => agent.status === "running").length;
  return running ? copy.subagentCount(running) : copy.subagentTotal(subagents.length);
}

/**
 * Subagents for the task panel: working agents first, then the most recently
 * finished ones. Saved or stale data (`live` false) never shows a working agent,
 * and an unresolved state is only worth showing while the session is live.
 */
export function visibleSubagents(subagents = [], live = false) {
  const running = live ? subagents.filter((agent) => agent.status === "running") : [];
  const finished = subagents
    .filter((agent) =>
      live ? agent.status !== "running" : ["completed", "failed"].includes(agent.status),
    )
    .slice(-RECENT_SUBAGENTS)
    .reverse();
  return [...running, ...finished];
}
