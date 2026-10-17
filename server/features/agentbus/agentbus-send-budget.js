import { serverMessages } from "../../lib/i18n/de.js";

// Stops runaway peer conversations: every send wakes its recipient, so two idle
// sessions could otherwise reply to each other indefinitely.
export const SEND_BUDGET = Object.freeze({
  senderPerMinute: 6,
  pairPerTenMinutes: 10,
  replyDepth: 12,
});

const minute = 60000;

/**
 * Checks a send against the project's stored messages. Returns null when the
 * send fits, otherwise the exceeded limit and the agent-facing German text.
 * A sender burst only has to wait for its window; pair and depth limits stop loops.
 */
export function sendBudgetRefusal(
  queue,
  { sender, recipient, replyTo, now },
  limits = SEND_BUDGET,
) {
  const text = serverMessages.agentbus;
  const from = { runtime: sender.runtime, session: sender.sessionId };
  const recent = queue.sentSince({ ...from, since: now - minute });
  if (recent.count >= limits.senderPerMinute) {
    const seconds = Math.max(1, Math.ceil((recent.oldest + minute - now) / 1000));
    return {
      limit: "sender",
      message: text.sendBudgetSender(limits.senderPerMinute, seconds),
    };
  }
  const pair = queue.sentSince({
    ...from,
    recipient: recipient.key,
    since: now - 10 * minute,
  });
  if (pair.count >= limits.pairPerTenMinutes)
    return {
      limit: "pair",
      message: text.sendBudgetPair(limits.pairPerTenMinutes, recipient.name),
    };
  if (replyTo && queue.replyDepth(replyTo, limits.replyDepth) >= limits.replyDepth)
    return { limit: "depth", message: text.sendBudgetDepth(limits.replyDepth) };
  return null;
}

/** Logs a refusal by limit and peer keys only; message text never reaches the log. */
export function refusalLogLine(refusal, sender, recipient) {
  return `AgentBus SEND_BUDGET refused (${refusal.limit}): ${sender.key} -> ${recipient.key}`;
}
