import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { serverMessages } from "../../lib/i18n/de.js";
import { assistantProblem } from "./assistant-validation.js";
import { validateQueueInput } from "./queued-messages.js";

// A queued message that could have gone out for this long is not sent anymore (a
// restored or long stopped host would otherwise deliver it days later).
const MAX_AGE = 24 * 3600 * 1000;
// Retries after a passing refusal back off from 2 s to 30 s per conversation; after
// ten tries or ten minutes the card says that delivery keeps being retried.
const FIRST_RETRY = 2000;
const LAST_RETRY = 30000;
const NOTICE_TRIES = 10;
const NOTICE_AFTER = 10 * 60 * 1000;
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
    retrying: message.retrying,
    ...(message.state === "failed" && message.error
      ? { error: message.error, ...messageIdentity(message.error) }
      : {}),
    createdAt: message.createdAt,
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
  service.changed({ conversationId });
  dispatchQueued(service, conversationId).catch(() => {});
  return queuedView(service, conversationId);
}

/** Returns the queued message to the owner's composer, unless it is on its way. */
export function takeBackQueued(service, conversationId) {
  service.store.getConversation(conversationId);
  const message = service.queued.take(conversationId);
  retriesOf(service).delete(conversationId);
  // Back in the composer, its files are fresh drafts again for the staging expiry.
  service.attachments.touch(conversationId, message.attachments);
  service.changed({ conversationId });
  return {
    text: message.text,
    teamAllowed: message.teamAllowed,
    attachments: service.attachments.staged(conversationId, message.attachments, false),
  };
}

// A queued message goes out as the turn of the person whose chat it is.
const turnContext = (conversation) =>
  typeof conversation.userId === "string"
    ? { kind: "user", userId: conversation.userId }
    : { kind: "owner" };
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
  const pending = service.ledger.pending();
  const running = new Set(pending.map((a) => a.id));
  const busy = new Set(
    pending.map((a) => service.ledger.getRequest(a.requestId).conversationId),
  );
  // A backoff behind other turns ends with them: a busy member that refused the
  // owner's turn takes it as soon as its own turn is over.
  const waits = (id) => {
    const entry = backoff.get(id);
    if (!entry || entry.at <= now) return false;
    return !entry.blockers.length || entry.blockers.some((a) => running.has(a));
  };
  const ready = [];
  for (const m of service.queued.waiting()) {
    if (conversationId && m.conversationId !== conversationId) continue;
    const conversation = service.store.getConversation(m.conversationId);
    if (
      busy.has(m.conversationId) ||
      conversation.archivedAt ||
      service.store.getAssistant(conversation.assistantId).archivedAt
    ) {
      service.queued.blocked(m);
      continue;
    }
    if (now - service.queued.deliverable(m, now) > MAX_AGE) {
      backoff.delete(m.conversationId);
      service.queued.fail(m, serverMessages.assistants.queuedExpired);
      service.changed({ conversationId: m.conversationId });
      continue;
    }
    if (!waits(m.conversationId)) ready.push(m);
  }
  await Promise.all(
    ready.map(async (message) => {
      if (!service.queued.begin(message)) return;
      try {
        await service.send(
          message.conversationId,
          delivery(message),
          turnContext(service.store.getConversation(message.conversationId)),
        );
        service.queued.done(message);
        backoff.delete(message.conversationId);
        service.changed({ conversationId: message.conversationId });
      } catch (error) {
        const result = outcome(error);
        if (result.retry) {
          service.queued.release(message);
          // A 409 means another turn holds it (a busy member, host concurrency): like
          // a running turn, that stops the expiry clock. Faults and an unready
          // service keep it running, so a host that stays down lets it expire.
          if (error.status === 409) service.queued.blocked(message);
          retryLater(service, message, [...running]);
          return;
        }
        backoff.delete(message.conversationId);
        service.queued.fail(message, result.error);
        service.changed({ conversationId: message.conversationId });
      }
    }),
  );
}

// Schedules the next try and, once retries have gone on for a while, shows it.
function retryLater(service, message, blockers) {
  const backoff = retriesOf(service);
  const now = service.now();
  const last = backoff.get(message.conversationId);
  const entry = {
    delay: Math.min((last?.delay ?? FIRST_RETRY / 2) * 2, LAST_RETRY),
    tries: (last?.tries ?? 0) + 1,
    since: last?.since ?? now,
    blockers,
  };
  entry.at = now + entry.delay;
  backoff.set(message.conversationId, entry);
  if (
    (entry.tries >= NOTICE_TRIES || now - entry.since >= NOTICE_AFTER) &&
    service.queued.markRetrying(message)
  )
    service.changed({ conversationId: message.conversationId });
}
