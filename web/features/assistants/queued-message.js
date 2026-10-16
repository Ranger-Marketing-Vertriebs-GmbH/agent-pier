// The message the owner queued while the agent works lives on the server
// (queued-dispatch.js) and comes with the history, so every tab and a reload see it.

// Back in the composer, the queued text comes before what was typed since.
export const takeBack = (text, draft) =>
  [text, draft]
    .map((part) => String(part || "").trimEnd())
    .filter((part) => part.trim())
    .join("\n");

/**
 * What the queued message's notice says: it is on its way (`sending`), was refused
 * (`failed`), waits for an agent that cannot take messages now (`blocked`: the
 * service is not ready, the agent is archived or a member is busy), keeps being
 * retried after refusals (`retrying`), or waits for the
 * current turn (`waiting`, also while an uncertain turn awaits its review).
 */
export function queuedNotice(queued, { active, available }) {
  if (!queued) return null;
  if (queued.state === "sending") return "sending";
  if (queued.state === "failed") return "failed";
  if (active) return "waiting";
  if (!available) return "blocked";
  // Delivery was refused for a while (server faults, a busy member): still retried.
  return queued.retrying ? "retrying" : "waiting";
}
