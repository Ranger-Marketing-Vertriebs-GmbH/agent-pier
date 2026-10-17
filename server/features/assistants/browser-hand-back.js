import { serverMessages } from "../../lib/i18n/de.js";

/**
 * Tells the agent its browser is back (browser-takeover.js): a queued owner message
 * in the agent's most recent chat, delivered once the agent is idle, so a run that
 * stopped at a sign-in or check continues. A message the owner queued there already
 * is never replaced; the agent's next browser call works in any case.
 */
export function noteBrowserHandBack(assistants, id, reason) {
  try {
    const latest = assistants.ledger.latestByConversation();
    let conversation = null;
    for (const row of latest) {
      const candidate = assistants.store.getConversation(row.conversation_id);
      if (candidate.assistantId === id && !candidate.archivedAt) conversation = candidate;
    }
    if (!conversation || assistants.queued?.get(conversation.id)) return null;
    const text =
      reason === "timeout"
        ? serverMessages.assistants.browserHandBackTimeout
        : serverMessages.assistants.browserHandedBack;
    return assistants.queue(conversation.id, { text });
  } catch {
    return null;
  }
}
