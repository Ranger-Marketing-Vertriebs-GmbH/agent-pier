import { assistantProblem, validateSendInput } from "./assistant-validation.js";

/**
 * One owner (or Telegram, or internal) turn of an AgentPier conversation, admitted by
 * the caller: the request is accepted in the ledger together with its trusted context
 * and staged attachments, then delivered once through `sessions.send`. A retry with
 * the same client request id returns the accepted request and never sends again.
 */
export async function sendTurn(service, conversationId, input, trustedContext) {
  validateSendInput(input);
  const context = {
    ...trustedContext,
    teamAllowed:
      ["owner", "telegram"].includes(trustedContext.kind) &&
      (input.teamAllowed === true ||
        (trustedContext.kind === "owner" && /^\/team\s+\S/.test(input.text))),
  };
  const conversation = service.store.getConversation(conversationId);
  const existing = service.ledger
    .requests(conversationId)
    .find((r) => r.clientRequestId === input.clientRequestId);
  if (existing) {
    const request = service.ledger.accept(conversationId, input);
    service.attachments.claim(conversationId, input.attachments, request.id, true);
    service.teams?.store.recordContext(request.id, context);
    return { request, attempt: service.ledger.attemptFor(request.id) };
  }
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
  const accept = () => {
    const request = service.ledger.accept(conversationId, input);
    service.attachments.claim(conversationId, input.attachments, request.id);
    service.teams?.store.recordContext(request.id, context);
    return { request, attempt: service.ledger.recordAttempt(request.id) };
  };
  const { request, attempt } = (service.teams?.store || service.attachments).transaction(
    accept,
  );
  try {
    const turn = await service.attachments.delivery(request, conversation.assistantId);
    const sent = await service.runtime.client.call("sessions.send", {
      key: conversation.runtimeSessionKey,
      ...turn,
      idempotencyKey: attempt.id,
    });
    service.ledger.transition(attempt.id, "accepted", { runtimeRunId: sent.runId });
  } catch {
    service.ledger.transition(attempt.id, "uncertain", {});
  }
  service.changed();
  return {
    request: service.ledger.getRequest(request.id),
    attempt: service.ledger.getAttempt(attempt.id),
  };
}
