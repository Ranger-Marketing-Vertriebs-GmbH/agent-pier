/**
 * What Enter or Send does with a written message. The composer never refuses in
 * silence: a message that cannot go out at once is queued on the server, which sends
 * it once the agent is free and its service ready (queued-dispatch.js), and every
 * other answer is shown.
 * - "queue": the agent works, a message already waits, the chat is being summarised,
 *   or the message cannot be delivered directly right now (`direct` false: the agent
 *   service is not ready, or the agent works on a team task).
 * - "sending": this tab's delivery of the message is still under way.
 * - "offline": AgentPier cannot be reached.
 * - "empty": nothing to send.
 * - "send": deliver it now.
 */
export function sendRoute({
  content,
  busy = false,
  active = false,
  queued = false,
  compacting = false,
  offline = false,
  direct = true,
}) {
  if (!content) return "empty";
  if (offline) return "offline";
  if (active || queued || compacting) return "queue";
  if (busy) return "sending";
  return direct ? "send" : "queue";
}
