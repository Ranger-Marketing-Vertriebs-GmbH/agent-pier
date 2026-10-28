import { assistantProblem } from "./assistant-validation.js";
import { isUserAgent } from "../users/user-access.js";

// The owner decided (AGENTPIER-274): an agent may always send files back to him.
// agentpier_share_file into the owner's own chat therefore depends on no turn: a direct
// turn, OpenClaw's own run after a background command (exec-continuation.js proves
// nothing for it), a check-in, a routine or a hook all share alike. What a share may
// read stays guarded (agent-share-source.js, agent-project-files.js shareRoot), and a
// file for anyone else (a restricted user's chat on a user agent) keeps the rules of
// the turn that shares it.

/** Whether `conversation` is the owner's own chat of an active agent that is no user agent. */
export function ownerChat(agent, conversation) {
  return (
    !!agent &&
    !agent.archivedAt &&
    !isUserAgent(agent) &&
    conversation?.assistantId === agent.id &&
    !conversation.userId &&
    !conversation.userReleased
  );
}

/**
 * The binding of a share in a chat session without a turn (TeamBridge.prepare): the
 * session's own chat when it is the owner's, `{ conversationId }`, or null.
 */
export function ownerShare(bridge, { agentId, sessionKey }) {
  const agent = bridge.agentOf(agentId);
  const conversation = bridge.assistants.store.conversationOfSession(sessionKey);
  return ownerChat(agent, conversation) ? { conversationId: conversation.id } : null;
}

/** Re-checks such a ticket on every step (TeamBridge.valid); throws. */
export function assertOwnerShare(bridge, record) {
  if (
    record.action !== "share_file" ||
    ownerShare(bridge, record)?.conversationId !== record.owner.conversationId
  )
    throw assistantProblem("invalid", 403);
  return record;
}
