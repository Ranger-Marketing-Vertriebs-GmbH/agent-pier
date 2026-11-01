import { assistantProblem } from "./assistant-validation.js";

/**
 * Signs a model account out (AssistantService.logoutAccount): through the provider
 * synchronization when it runs, else once no turn and no requested summary uses an
 * agent on that connection.
 */
export function logoutAccount(service, accounts, id) {
  // Maintenance drains admission locks itself; entering it from admit() would
  // wait on this operation's own lock indefinitely.
  if (service.providerSynchronization) {
    service.requireReady();
    accounts.record(id);
    return service.providerSynchronization.change(id, () => accounts.logout(id), {
      online: true,
    });
  }
  return service.admit(async () => {
    await service.settleUserTurns();
    if (
      service.ledger.pending().some((attempt) => {
        const request = service.ledger.getRequest(attempt.requestId);
        const conversation = service.store.getConversation(request.conversationId);
        return (
          service.store.getAssistant(conversation.assistantId).model.connectionId === id
        );
      }) ||
      // A history summarised on request uses the agent's model too (long-chats.js).
      service.longChats.runningFor(
        new Set(
          service.store
            .listAssistants()
            .filter((a) => a.model?.connectionId === id)
            .map((a) => a.id),
        ),
      )
    )
      throw assistantProblem("active", 409);
    const result = await accounts.logout(id);
    service.changed();
    return result;
  });
}
