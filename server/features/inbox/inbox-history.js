// How an item that no longer waits ended, read from the audit log: every decision
// (inline, in place, by Telegram or MCP) is audited there. A stale link shows that
// outcome for a day; older or unaudited ends (an expiry, a session that stopped) are
// simply no longer waiting.
export const historyWindowMs = 24 * 60 * 60000;
const audited = {
  question: ["request.answered", "request.handed-off", "request.expired"],
  approval: ["request.answered", "request.handed-off", "request.expired"],
  action: ["assistant.answered"],
  team: ["assistant.answered"],
  gate: [
    "pipeline.updated",
    "pipeline.overridden",
    "pipeline.cancelled",
    "pipeline.completed",
    "pipeline.failed",
  ],
};
const outcomes = {
  "request.answered": "answered",
  "request.handed-off": "handedOff",
  "request.expired": "closed",
  "assistant.answered": "answered",
  "pipeline.updated": "answered",
  "pipeline.overridden": "answered",
  "pipeline.cancelled": "cancelled",
  "pipeline.completed": "answered",
  "pipeline.failed": "answered",
};

export function itemHistory(audit, type, id, now = Date.now()) {
  if (!audit?.recent || !audited[type]) return { state: "gone" };
  let event = null;
  try {
    event = audit.recent({
      actions: audited[type],
      id,
      since: new Date(now - historyWindowMs).toISOString(),
    });
  } catch {
    // An unreadable audit log only loses the detail, never the answer "not waiting".
  }
  // A gate's own entry into waiting is audited by the system as an update too.
  if (!event || (event.action === "pipeline.updated" && event.source !== "user"))
    return { state: "gone" };
  return {
    state: "done",
    outcome: outcomes[event.action] || "answered",
    at: event.createdAt,
    ...(event.details?.decision ? { decision: event.details.decision } : {}),
    ...(event.details?.channel ? { channel: event.details.channel } : {}),
  };
}
