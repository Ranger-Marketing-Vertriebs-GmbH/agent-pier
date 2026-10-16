import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { assistantProblem } from "./assistant-validation.js";
import { validateQueueInput } from "./queued-messages.js";

// A queued message older than this is not sent anymore (a restored or long stopped
// host would otherwise deliver it days later).
const MAX_AGE = 24 * 3600 * 1000;
// Retries after a passing refusal back off from 2 s to 30 s per conversation.
const FIRST_RETRY = 2000;
const LAST_RETRY = 30000;
const retries = new WeakMap();
const retriesOf = (service) => {
  if (!retries.has(service)) retries.set(service, new Map());
  return retries.get(service);
};

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
  const conversation = service.store.getConversation(conversationId);
  if (
    conversation.archivedAt ||
    service.store.getAssistant(conversation.assistantId).archivedAt
  )
    throw assistantProblem("queuedArchived", 409);
  service.attachments.staged(conversationId, value.attachments);
  service.queued.put(conversationId, value);
  retriesOf(service).delete(conversationId);
  service.changed();
  dispatchQueued(service, conversationId).catch(() => {});
  return queuedView(service, conversationId);
}

/** Returns the queued message to the owner's composer, unless it is on its way. */
export function takeBackQueued(service, conversationId) {
  service.store.getConversation(conversationId);
  const message = service.queued.take(conversationId);
  // Back in the composer, its files are fresh drafts again for the staging expiry.
  service.attachments.touch(conversationId, message.attachments);
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
// Refusals that pass (the service is not ready, another turn runs) and unexpected
// server faults are retried; a refusal of the message itself keeps it as failed.
const outcome = (error) => {
  const status = error?.status;
  if (status === 409 || status >= 500) return { retry: true };
  if (error?.key && status >= 400) return { error: error.message };
  return { error: serverMessages.http.internalError };
};

/** Called by the service's poll: retries messages that wait without a turn ending. */
export function pollQueued(service) {
  if (service.queued.waiting().length) dispatchQueued(service).catch(() => {});
}

/**
 * Sends every waiting queued message whose conversation is idle: no unresolved
 * attempt (an uncertain or interrupted one waits for its review), a ready service and
 * an agent that is not archived. Each goes through the normal owner send with its own
 * delivery key, so the ledger dedupes a repeated dispatch. Only real changes are
 * published: a retry that leaves the message waiting is no news for the browsers.
 */
export async function dispatchQueued(service, conversationId) {
  if (service.closed || service.maintenance || !service.runtime.client?.ready) return;
  const now = service.now();
  const backoff = retriesOf(service);
  const busy = new Set(
    service.ledger
      .pending()
      .map((a) => service.ledger.getRequest(a.requestId).conversationId),
  );
  const ready = [];
  for (const m of service.queued.waiting()) {
    if (conversationId && m.conversationId !== conversationId) continue;
    if (now - Date.parse(m.updatedAt) > MAX_AGE) {
      service.queued.fail(m, serverMessages.assistants.queuedExpired);
      service.changed();
      continue;
    }
    const conversation = service.store.getConversation(m.conversationId);
    if (
      busy.has(m.conversationId) ||
      (backoff.get(m.conversationId)?.at ?? 0) > now ||
      conversation.archivedAt ||
      service.store.getAssistant(conversation.assistantId).archivedAt
    )
      continue;
    ready.push(m);
  }
  await Promise.all(
    ready.map(async (message) => {
      if (!service.queued.begin(message)) return;
      try {
        await service.send(message.conversationId, delivery(message), { kind: "owner" });
        service.queued.done(message);
        backoff.delete(message.conversationId);
        service.changed();
      } catch (error) {
        const result = outcome(error);
        if (result.retry) {
          service.queued.release(message);
          const delay = Math.min(
            (backoff.get(message.conversationId)?.delay ?? FIRST_RETRY / 2) * 2,
            LAST_RETRY,
          );
          backoff.set(message.conversationId, { delay, at: service.now() + delay });
          return;
        }
        backoff.delete(message.conversationId);
        service.queued.fail(message, result.error);
        service.changed();
      }
    }),
  );
}
