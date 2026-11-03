// The ticket sequence of a project as the Tickets tab shows it: the tone of each state
// and the owner actions the server accepts for an item
// (server/features/tickets/sequence-service.js).

export const QUEUE_STATES = Object.freeze([
  "waiting",
  "running",
  "awaiting-merge",
  "needs-owner",
  "done",
]);

const TONES = {
  done: "ok",
  "needs-owner": "error",
  "awaiting-merge": "warning",
  running: "neutral",
  waiting: "neutral",
};

/** The StatusChip tone of a queue state. */
export const queueStateTone = (state) => TONES[state] ?? "neutral";

const webUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
};

/**
 * The actions of a queue item, in menu order. Retry is for a parked item only; Mark
 * done for a parked or waiting one; Remove for every item nobody works on.
 */
export function queueItemActions(item) {
  const actions = [];
  if (item.state === "needs-owner") actions.push("retry");
  if (item.state === "needs-owner" || item.state === "waiting") actions.push("done");
  if (item.state !== "running" && item.state !== "awaiting-merge") actions.push("remove");
  if (item.sessionId) actions.push("open-session");
  if (item.runId) actions.push("open-run");
  if (item.pr?.url && webUrl(item.pr.url)) actions.push("open-pr");
  return actions;
}

/** The queue route of a project, of one item, or of an item's action. */
export function queueItemPath(projectId, itemId, action) {
  const base = `/tickets/projects/${encodeURIComponent(projectId)}/queue`;
  if (!itemId) return base;
  return `${base}/${encodeURIComponent(itemId)}${action ? `/${action}` : ""}`;
}
