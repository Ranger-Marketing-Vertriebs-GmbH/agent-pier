import { assistantProblem } from "../assistant-validation.js";
import { workspaceContext } from "../workspace-calls.js";

const refused = () => assistantProblem("invalid", 403);
const live = new Set(["pending", "accepted", "running"]);

/**
 * The turn context of an agentpier_coding_session call, with its `sessionClass`:
 * - a wake turn AgentPier sent for one of the agent's sessions (turn context
 *   `{ kind: "coding-session", sessionId }`) takes the class of the session's own
 *   record and names it in `wake`;
 * - `hook`: a hook run with its Coding tick (none without it);
 * - `routine`: a routine's own run;
 * - `team`: a lead's task for its member (`leadRequest`), a temporary member's team
 *   turn (`requestedBy`) or a lead's follow-up on its member's result
 *   (`memberResult`); starts on these paths wait for the owner;
 * - `owner`: the owner's own message, from AgentPier or his Telegram chat, and goal
 *   continuations.
 * A command's completion run, a restricted user's turn and forwarded content are
 * refused (403), as is every turn workspaceContext refuses.
 */
export function sessionContext(w, inv) {
  inv.assertCurrent();
  if (inv.continuation) throw refused();
  const wake = inv.attemptId ? wakeContext(w, inv) : null;
  if (wake) return wake;
  const ctx = workspaceContext(w, inv);
  if (ctx.execContinuation || ctx.origin?.kind === "user" || ctx.origin?.forwarded)
    throw refused();
  if (ctx.hook) {
    if (!ctx.hook.coding) throw refused();
    return { ...ctx, sessionClass: "hook" };
  }
  if (ctx.routine) return { ...ctx, sessionClass: "routine" };
  if (ctx.leadRequest || ctx.requestedBy || ctx.memberResult)
    return { ...ctx, sessionClass: "team" };
  return { ...ctx, sessionClass: "owner" };
}

// A wake turn of one of the agent's sessions, or null for any other turn.
function wakeContext(w, inv) {
  const attempt = w.a.ledger.getAttempt(inv.attemptId);
  if (!live.has(attempt.state) || attempt.reviewedAt) throw refused();
  const req = w.a.ledger.getRequest(attempt.requestId),
    chat = w.a.store.getConversation(req.conversationId);
  const origin = w.a.teams.store.context(req.id);
  if (origin?.kind !== "coding-session") return null;
  const record = w.sessions.store.get(origin.sessionId);
  if (
    !record ||
    record.assistantId !== chat.assistantId ||
    record.conversationId !== chat.id
  )
    throw refused();
  w.access.eligible(chat.assistantId);
  return {
    assistantId: chat.assistantId,
    conversationId: chat.id,
    attemptId: attempt.id,
    origin,
    sessionClass: record.origin.class,
    wake: { sessionId: record.sessionId },
  };
}
