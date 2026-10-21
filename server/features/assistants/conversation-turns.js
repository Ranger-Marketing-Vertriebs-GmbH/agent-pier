import { assistantProblem, validateSendInput } from "./assistant-validation.js";
import { memberLevel } from "../users/user-access.js";
import { plainTurnText } from "./plain-turn-text.js";
import { titleFromTurn } from "./chat-titles.js";
import { chatProblem } from "./agent-chats.js";

function usersAgent(service, conversation) {
  try {
    return Boolean(service.store.getAssistant(conversation.assistantId).userAccess);
  } catch {
    return false;
  }
}

/**
 * One owner (or Telegram, or internal) turn of an AgentPier conversation, admitted by
 * the caller: the request is accepted in the ledger together with its trusted context
 * and staged attachments, then delivered once through `sessions.send`. A retry with
 * the same client request id returns the accepted request and never sends again.
 */
export async function sendTurn(service, conversationId, input, trustedContext) {
  validateSendInput(input);
  const conversation = service.store.getConversation(conversationId);
  const context = {
    ...trustedContext,
    // A user's agent never leads a team (user-agent-lock.js), whoever writes to it.
    teamAllowed:
      ["owner", "telegram"].includes(trustedContext.kind) &&
      !usersAgent(service, conversation) &&
      (input.teamAllowed === true ||
        (trustedContext.kind === "owner" && /^\/team\s+\S/.test(input.text))),
  };
  const existing = service.ledger
    .requests(conversationId)
    .find((r) => r.clientRequestId === input.clientRequestId);
  if (existing) {
    const request = service.ledger.accept(conversationId, input);
    service.attachments.claim(conversationId, input.attachments, request.id, true);
    service.teams?.store.recordContext(request.id, context);
    return { request, attempt: service.ledger.attemptFor(request.id) };
  }
  // A deleted or disabled user's chat, or one of a user who left the agent, takes no
  // new turns: not from her Telegram bot, a reminder or anything else. Nor does the
  // owner's chat on a shared agent that has since become a user's own agent.
  const agent = service.store.getAssistant(conversation.assistantId);
  if (
    conversation.userReleased ||
    conversation.deletedUser ||
    (typeof conversation.userId === "string"
      ? !memberLevel(agent, conversation.userId) ||
        service.userActive?.(conversation.userId) === false
      : agent.userAccess?.mode === "own")
  )
    throw assistantProblem("notFound", 404);
  // An archived chat is read-only until it is restored (chat-removal.js).
  if (conversation.archivedAt) throw chatProblem("CHAT_ARCHIVED");
  service.requireReady();
  if (
    service.ledger
      .pending()
      .some(
        (a) => service.ledger.getRequest(a.requestId).conversationId === conversationId,
      )
  )
    throw assistantProblem("active", 409);
  service.teams?.assertMemberTurn(conversation.assistantId, context);
  await service.config.apply(conversation.assistantId);
  service.teams?.assertMemberTurn(conversation.assistantId, context);
  // Applied while the write guard was still missing: the turn runs read-only.
  const readOnly = !!service.config.writeGuardPending?.(
    service.store.getAssistant(conversation.assistantId),
  );
  const accept = () => {
    const request = service.ledger.accept(conversationId, input);
    service.attachments.claim(conversationId, input.attachments, request.id);
    service.teams?.store.recordContext(request.id, context);
    return { request, attempt: service.ledger.recordAttempt(request.id) };
  };
  const { request, attempt } = (service.teams?.store || service.attachments).transaction(
    accept,
  );
  // The chat list orders chats by their latest turn and names them after their first
  // (agent-chats.js, chat-titles.js).
  service.store.updateConversation(conversationId, {
    lastActivityAt: new Date(service.now?.() ?? Date.now()).toISOString(),
  });
  titleFromTurn(service, conversation, context);
  // The reconciler leaves an attempt alone while its send is under way.
  const sending = (service.sending ??= new Set());
  sending.add(attempt.id);
  const generation = service.runtime.generationId ?? null;
  try {
    // A user's chat (web, her Telegram bot, queued) never sends OpenClaw commands,
    // and its files are announced as hers.
    const byUser = typeof conversation.userId === "string";
    const turn = await service.attachments.delivery(
      byUser ? { ...request, text: plainTurnText(request.text) } : request,
      conversation.assistantId,
      { byUser },
    );
    const sent = await service.runtime.client.call("sessions.send", {
      key: conversation.runtimeSessionKey,
      ...turn,
      idempotencyKey: attempt.id,
    });
    service.ledger.transition(attempt.id, "accepted", { runtimeRunId: sent.runId });
  } catch (error) {
    // A busy Gateway may run a turn whose acknowledgement timed out: its own
    // evidence of the run confirms it later (run-confirmation.js). The send keeps the
    // client's short timeout, so the admission lock is never held long.
    service.ledger.transition(
      attempt.id,
      "uncertain",
      error?.code === "TIMEOUT" ? { unconfirmed: "send", generation } : {},
    );
  } finally {
    sending.delete(attempt.id);
  }
  service.changed({ conversationId });
  return {
    request: service.ledger.getRequest(request.id),
    attempt: service.ledger.getAttempt(attempt.id),
    ...(readOnly ? { readOnly } : {}),
  };
}
