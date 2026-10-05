import { chatObservabilityCopy as copy } from "../../lib/i18n/messages/chat-observability.js";

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

/** How long a finished subagent stays listed, and how long it then fades out. */
export const SUBAGENT_LINGER_MS = 10_000;
export const SUBAGENT_FADE_MS = 400;
/** Clock-skew tolerance for an agent first seen already finished. */
export const SUBAGENT_FIRST_SEEN_TOLERANCE_MS = 60_000;

const updated = (agent) => {
  const time = Date.parse(agent.updatedAt);
  return Number.isFinite(time) ? time : null;
};

/**
 * Subagents for the task panel at client time `now`. Working agents come first.
 * A finished agent stays listed for SUBAGENT_LINGER_MS from the first frame in
 * which this client saw it finished, then fades (`fading`) and is removed for
 * good, unless its state changes again (for one more linger) or it works again.
 * Without a fade (`fade` 0, reduced motion) it leaves when its linger ends.
 * Agents that finished long before they were first seen are not listed. Saved or stale data (`live` false) never shows
 * a working agent, and an unresolved state is only worth showing while live.
 *
 * `memory` (a Map per session view) remembers what was seen between frames; `next`
 * is the client time of the next change without new data, or null.
 */
export function presentSubagents(
  memory,
  subagents = [],
  live = false,
  now = Date.now(),
  { fade = SUBAGENT_FADE_MS } = {},
) {
  const running = [],
    finished = [];
  let next = null;
  const wake = (time) => {
    if (next === null || time < next) next = time;
  };
  for (const [order, agent] of subagents.entries()) {
    const seen = memory.get(agent.id);
    const { status } = agent;
    if (status === "running") {
      if (!live) continue;
      memory.set(agent.id, { status, running: true });
      running.push(agent);
      continue;
    }
    if (!live && !["completed", "failed"].includes(status)) continue;
    // A removed agent stays gone until its state changes again.
    if (seen?.removed && seen.status === status) continue;
    let finishedAt = seen?.removed ? undefined : seen?.finishedAt;
    if (finishedAt === undefined) {
      const time = updated(agent);
      const changed = seen?.running || seen?.removed;
      if (!changed && time !== null && now - time > SUBAGENT_FIRST_SEEN_TOLERANCE_MS) {
        memory.set(agent.id, { status, removed: true });
        continue;
      }
      finishedAt = now;
    }
    memory.set(agent.id, { status, finishedAt });
    const fadeAt = finishedAt + SUBAGENT_LINGER_MS,
      removeAt = fadeAt + fade;
    if (now >= removeAt) {
      memory.set(agent.id, { status, removed: true });
      continue;
    }
    wake(now < fadeAt ? fadeAt : removeAt);
    finished.push({
      agent: now < fadeAt ? agent : { ...agent, fading: true },
      finishedAt,
      order,
    });
  }
  // Newest completion first; agents first seen together keep their observed order.
  finished.sort((a, b) => b.finishedAt - a.finishedAt || a.order - b.order);
  return { subagents: [...running, ...finished.map(({ agent }) => agent)], next };
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
