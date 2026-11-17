import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";

export const subagentStatus = (agent) =>
  ["running", "completed", "failed", "stopped"].includes(agent?.status)
    ? agent.status
    : "unknown";

/** Status label shared by chat rows and the background tasks sheet. */
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
