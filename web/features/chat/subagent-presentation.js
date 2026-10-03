import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";

export const RECENT_SUBAGENTS = 5;

export const subagentStatus = (agent) =>
  ["running", "completed", "failed"].includes(agent?.status) ? agent.status : "unknown";

/** Status label shared by chat rows and the task panel. */
export const subagentStatusLabel = (status) => copy[subagentStatus({ status })];

/**
 * "Active subagents (m)" when only working agents are listed, "Subagents (n)"
 * when none works, otherwise "Subagents (n · m active)".
 */
export function subagentHeading(subagents) {
  const running = subagents.filter((agent) => agent.status === "running").length;
  if (!running) return copy.subagentTotal(subagents.length);
  if (running === subagents.length) return copy.subagentCount(running);
  return copy.subagentSummary(subagents.length, running);
}

const updated = (agent) => {
  const time = Date.parse(agent.updatedAt);
  return Number.isFinite(time) ? time : -Infinity;
};

/**
 * Subagents for the task panel: working agents first, then the five most
 * recently updated finished ones. Saved or stale data (`live` false) never shows
 * a working agent, and an unresolved state is only worth showing while live.
 */
export function visibleSubagents(subagents = [], live = false) {
  const running = live ? subagents.filter((agent) => agent.status === "running") : [];
  const finished = subagents
    .map((agent, order) => ({ agent, order }))
    .filter(({ agent }) =>
      live ? agent.status !== "running" : ["completed", "failed"].includes(agent.status),
    )
    // Newest first; without timestamps the later observation counts as newer.
    .sort((a, b) => updated(b.agent) - updated(a.agent) || b.order - a.order)
    .slice(0, RECENT_SUBAGENTS)
    .map(({ agent }) => agent);
  return [...running, ...finished];
}

/**
 * Status of a subagent chat row. Rows from older pages are frozen snapshots, so
 * while the session is live the observed state of the same agent wins. A row
 * never reports a working agent from saved, stale or unobserved data.
 */
export function subagentRowStatus(message, observed = [], live = false) {
  const own = subagentStatus(message);
  if (!live) return own === "running" ? "unknown" : own;
  const agentId = message.subagent?.agentId;
  // Before its launch result a foreground call has no agent id yet; its row is
  // part of the live window.
  if (!agentId) return own;
  const agent = observed.find((entry) => entry.id === agentId);
  if (agent) return subagentStatus(agent);
  return own === "running" ? "unknown" : own;
}
