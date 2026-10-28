import { isDeepStrictEqual } from "node:util";
import { assistantProblem } from "./assistant-validation.js";
import { isUserAgent } from "../users/user-access.js";
import { mainConversation } from "./routine-targets.js";
import { routineActions } from "./team-bridge-actions.js";
import * as hooks from "./agent-hook-bridge.js";

// The owner decided (AGENTPIER-274): an agent may always send files back to him.
// agentpier_share_file into the owner's own chat therefore depends on no turn: a direct
// turn, OpenClaw's own run after a background command (exec-continuation.js proves
// nothing for it), a check-in, a routine or a hook, also after its event settled, all
// share alike. What a share may read stays guarded (agent-share-source.js,
// agent-project-files.js shareRoot), and a file for anyone else (a restricted user's
// chat on a user agent) keeps the rules of the turn that shares it.

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
 * Where a share of a session without a turn goes when no running hook or routine
 * holds it: a hook's session after its event settled sends to the agent's main chat
 * (`hookId`, `eventId`: workspace files and that hook's folders only); any other
 * session to its own chat when that is the owner's. `{ conversationId, ... }` or null.
 */
export function ownerShare(bridge, input) {
  const agent = bridge.agentOf(input.agentId);
  const event = hooks.hookSession(bridge, input);
  if (event) {
    const main =
      event.assistantId === agent?.id &&
      mainConversation(bridge.assistants.store, agent.id);
    return ownerChat(agent, main)
      ? { conversationId: main.id, hookId: event.hookId, eventId: event.id }
      : null;
  }
  const conversation = bridge.assistants.store.conversationOfSession(input.sessionKey);
  return ownerChat(agent, conversation) ? { conversationId: conversation.id } : null;
}

/**
 * The binding of a call in a session without a turn, apart from a command's
 * completion run (exec-continuation.js): a hook's run serves its own actions while
 * its event runs, a routine's run its routine actions, and every other run of the
 * owner's chat a share for him. `{ hook | routine | owner }`, or null; a hook's
 * session refuses every other action.
 */
export function turnlessBinding(bridge, input) {
  if (hooks.hookSession(bridge, input)) {
    const hook = hooks.hookActions.has(input.action) && hooks.hookRun(bridge, input);
    if (hook) return { hook };
    const owner = input.action === "share_file" && ownerShare(bridge, input);
    if (owner) return { owner };
    throw assistantProblem("invalid", 403);
  }
  if (!routineActions.has(input.action)) return null;
  // Only SSH (on hosts granted "incl. routines"), shared files, project folders, the
  // lead's ask, delegate and members, and a member's own tools serve a routine's run.
  const routine = bridge.routineRun(input);
  if (routine) return { routine };
  const owner = input.action === "share_file" && ownerShare(bridge, input);
  return owner ? { owner } : null;
}

/** Re-checks an owner share's ticket on every step (TeamBridge.valid); throws. */
export function assertOwnerShare(bridge, record) {
  if (
    record.action !== "share_file" ||
    !isDeepStrictEqual(ownerShare(bridge, record), record.owner)
  )
    throw assistantProblem("invalid", 403);
  return record;
}
