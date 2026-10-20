import { isUserAgent } from "../users/user-access.js";
import { agentPerson } from "./reminder-audience.js";
import { mainConversation } from "./routine-targets.js";

/**
 * Tells the agent its browser is back (browser-takeover.js): a queued owner message
 * in the agent's most recent chat, delivered once the agent is idle, so a run that
 * stopped while the owner held the browser continues. Sent only when the agent was
 * refused during the lease (never to wake an old chat), and never over a message
 * the owner queued there. In English, like the tool guard's refusals the agent read.
 */
export const handBackNotes = {
  owner:
    "The owner has handed the browser back to you. Continue the browser task where you left off.",
  timeout:
    "The browser is back with you: the owner has not used it for a while. Continue the browser task where you left off.",
};

// A user agent's note goes to the main chat of the person who drove the browser.
function driverChat(assistants, id) {
  let agent = null;
  try {
    agent = assistants.store.getAssistant(id);
  } catch {
    /* An agent that went away: the latest chat decides, as before. */
  }
  if (!isUserAgent(agent)) return undefined;
  const person = assistants.liveView?.driver(id) ?? agentPerson(agent);
  return mainConversation(assistants.store, id, person);
}

export function noteBrowserHandBack(assistants, id, reason) {
  let conversation = driverChat(assistants, id);
  if (conversation === undefined) conversation = latestChat(assistants, id);
  if (!conversation) return null;
  try {
    if (assistants.queued?.get(conversation.id)) return null;
    return assistants.queue(conversation.id, {
      text: reason === "timeout" ? handBackNotes.timeout : handBackNotes.owner,
    });
  } catch {
    return null;
  }
}

function latestChat(assistants, id) {
  let conversation = null;
  for (const row of assistants.ledger.latestByConversation()) {
    try {
      const candidate = assistants.store.getConversation(row.conversationId);
      if (candidate.assistantId === id && !candidate.archivedAt) conversation = candidate;
    } catch {
      /* A conversation that went away meanwhile. */
    }
  }
  return conversation;
}
