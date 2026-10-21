import { isUserAgent } from "../users/user-access.js";
import { agentPerson } from "./reminder-audience.js";
import { mainConversation } from "./routine-targets.js";

/**
 * Tells the agent its browser is back (browser-takeover.js): a queued message in the
 * chat whose turn drove the browser (or else the driver's main chat, or the agent's
 * most recent chat), delivered once the agent is idle, so a run that
 * stopped while the owner held the browser continues. Sent only when the agent was
 * refused during the lease (never to wake an old chat), and never over a message
 * the owner queued there. In English, like the tool guard's refusals the agent read.
 */
export const handBackNotes = {
  owner:
    "The owner has handed the browser back to you. Continue the browser task where you left off.",
  timeout:
    "The browser is back with you: the owner has not used it for a while. Continue the browser task where you left off.",
  // A user agent's driver is its user: the owner neither drives nor reads her chat.
  user: "Your user has handed the browser back to you. Continue the browser task where you left off.",
  userTimeout:
    "The browser is back with you: your user has not used it for a while. Continue the browser task where you left off.",
};

/** The note for `reason` ("owner" or "timeout") to the person who held the browser. */
export function handBackNote(reason, person) {
  if (person)
    return reason === "timeout" ? handBackNotes.userTimeout : handBackNotes.user;
  return reason === "timeout" ? handBackNotes.timeout : handBackNotes.owner;
}

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

// The chat whose turn drove the browser, while it still takes turns and belongs to
// the person who drives now.
function drivingChat(assistants, id) {
  const conversationId = assistants.liveView?.driverConversation?.(id);
  if (!conversationId) return null;
  try {
    const conversation = assistants.store.getConversation(conversationId);
    const person = typeof conversation.userId === "string" ? conversation.userId : null;
    if (
      conversation.assistantId !== id ||
      conversation.archivedAt ||
      person !== (assistants.liveView.driver(id) ?? null)
    )
      return null;
    return conversation;
  } catch {
    return null;
  }
}

export function noteBrowserHandBack(assistants, id, reason) {
  let conversation = drivingChat(assistants, id) ?? driverChat(assistants, id);
  if (conversation === undefined) conversation = latestChat(assistants, id);
  if (!conversation) return null;
  try {
    if (assistants.queued?.get(conversation.id)) return null;
    const person = typeof conversation.userId === "string" ? conversation.userId : null;
    return assistants.queue(conversation.id, { text: handBackNote(reason, person) });
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
