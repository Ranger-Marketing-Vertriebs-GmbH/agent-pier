import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { validateQueueInput } from "./queued-messages.js";

// The queued message as every tab of the chat shows it. Files that are gone since
// are left out; its delivery then fails and says so.
export function queuedView(service, conversationId) {
  const message = service.queued?.get(conversationId);
  if (!message) return null;
  return {
    text: message.text,
    teamAllowed: message.teamAllowed,
    attachments: service.attachments.staged(conversationId, message.attachments, false),
    state: message.state,
    ...(message.state === "failed" && message.error
      ? { error: message.error, ...messageIdentity(message.error) }
      : {}),
    updatedAt: message.updatedAt,
  };
}

/** Queues (or extends) the owner's message for when the conversation is idle. */
export function queueMessage(service, conversationId, input) {
  const value = validateQueueInput(input);
  service.store.getConversation(conversationId);
  service.attachments.staged(conversationId, value.attachments);
  service.queued.put(conversationId, value);
  service.changed();
  dispatchQueued(service, conversationId).catch(() => {});
  return queuedView(service, conversationId);
}

/** Returns the queued message to the owner's composer, unless it is on its way. */
export function takeBackQueued(service, conversationId) {
  service.store.getConversation(conversationId);
  const message = service.queued.take(conversationId);
  service.changed();
  return {
    text: message.text,
    teamAllowed: message.teamAllowed,
    attachments: service.attachments.staged(conversationId, message.attachments, false),
  };
}

const delivery = (message) => ({
  clientRequestId: message.clientRequestId,
  text: message.text,
  ...(message.teamAllowed ? { teamAllowed: true } : {}),
  ...(message.attachments.length ? { attachments: message.attachments } : {}),
});
// Refusals that pass: the service is not ready, or another turn runs.
const later = (error) => error?.status === 503 || error?.status === 409;

/**
 * Sends every waiting queued message whose conversation is idle: no unresolved
 * attempt (an uncertain or interrupted one waits for its review), a ready service and
 * an agent that is not archived. Each goes through the normal owner send with its own
 * delivery key, so a dispatch repeated after a restart is answered by the ledger
 * instead of being sent again.
 */
export async function dispatchQueued(service, conversationId) {
  if (service.closed || service.maintenance || !service.runtime.client?.ready) return;
  const busy = new Set(
    service.ledger
      .pending()
      .map((a) => service.ledger.getRequest(a.requestId).conversationId),
  );
  const ready = service.queued
    .waiting()
    .filter(
      (m) =>
        (!conversationId || m.conversationId === conversationId) &&
        !busy.has(m.conversationId) &&
        !service.store.getAssistant(
          service.store.getConversation(m.conversationId).assistantId,
        ).archivedAt,
    );
  await Promise.all(
    ready.map(async (message) => {
      if (!service.queued.begin(message)) return;
      service.changed();
      try {
        await service.send(message.conversationId, delivery(message), { kind: "owner" });
        service.queued.done(message);
      } catch (error) {
        if (later(error)) service.queued.release(message);
        else service.queued.fail(message, error?.message);
      } finally {
        service.changed();
      }
    }),
  );
}
