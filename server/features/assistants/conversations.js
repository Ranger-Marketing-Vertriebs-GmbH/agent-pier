import { createHash } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { actionNotes } from "./assistant-action-notifications.js";
import { requestsWithSources, turnKey, withMessageSources } from "./message-source.js";
import { requestsWithAttachments, withAttachments } from "./attachment-history.js";
import { withRoutineResults } from "./routine-results.js";
import { withMemoryNotes } from "./memory-notes.js";
import { historyTextLimit } from "./history-text.js";
import { cachedWindow } from "./assistant-store.js";
import { completePage, historyReads, withoutMarks } from "./history-completion.js";
export function publicMessages(messages = []) {
  const seen = new Set();
  return messages.flatMap((m) => {
    if (!["user", "assistant"].includes(m.role)) return [];
    const text =
      typeof m.content === "string"
        ? m.content
        : (m.content || [])
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join("\n");
    if (!text) return [];
    const id =
      m.__openclaw?.id ||
      createHash("sha256")
        .update(JSON.stringify([m.role, m.timestamp, text]))
        .digest("hex");
    if (seen.has(id)) return [];
    seen.add(id);
    const key = m.role === "user" && turnKey(m);
    return [
      {
        id,
        role: m.role,
        text,
        timestamp: m.timestamp || 0,
        runId: m.__openclaw?.runId || null,
        // Internal: links the turn to its attempt (message-source.js), never served.
        ...(key && { turnKey: key }),
      },
    ];
  });
}
// Turns AgentPier itself submits for synthesis carry attributed reports, not owner
// words. The ledger keeps their exact text for audit; the visible history shows a
// compact event in their place.
const internalKinds = new Set([
  "team-result",
  "coding-result",
  "member-result",
  "memory-result",
  "ssh-result",
]);
function hideInternal(messages, requests, contexts, attempts) {
  const internal = requests
    .map((r) => [r, contexts.get(r.id)?.kind])
    .filter(([, kind]) => internalKinds.has(kind));
  if (!internal.length) return { messages, requests };
  // A turn's delivery key names its request; the text decides only without one.
  const kindOf = (m) => {
    const kind =
      m.turnKey && attempts.has(m.turnKey)
        ? contexts.get(attempts.get(m.turnKey))?.kind
        : internal.find(([r]) => m.text === r.text || m.text.endsWith(r.text))?.[1];
    return internalKinds.has(kind) ? kind : null;
  };
  return {
    messages: messages.map((m) => {
      const kind = m.role === "user" && kindOf(m);
      return kind
        ? { id: m.id, role: "event", event: kind, timestamp: m.timestamp, runId: m.runId }
        : m;
    }),
    requests: requests.map((r) => {
      const kind = internal.find(([x]) => x === r)?.[1];
      if (!kind) return r;
      const { text: _text, ...rest } = r;
      return { ...rest, internal: kind };
    }),
  };
}
/**
 * One message of a conversation read on its own with AgentPier's text limit
 * instead of OpenClaw's page default (8000 characters per message); null when
 * the Gateway does not serve it.
 */
export async function conversationMessage(service, id, messageId) {
  const conversation = service.store.getConversation(id);
  const client = service.runtime.client;
  const generation = service.runtime.generation;
  // Like a history page: no read while the runtime is swapped or recovering.
  const unsettled = () =>
    service.maintenance ||
    service.recovering ||
    service.closed ||
    service.runtime.generation !== generation ||
    service.runtime.client !== client;
  if (!client?.ready || typeof messageId !== "string" || unsettled()) return null;
  const page = await client.call("chat.history", {
    sessionKey: conversation.runtimeSessionKey,
    messageId,
    limit: 1,
    maxChars: historyTextLimit,
  });
  if (unsettled()) return null;
  return publicMessages(page?.messages).find((m) => m.id === messageId)?.text ?? null;
}
// Cached messages are flat records of primitive fields.
function sameMessage(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}
// Single reads of cut messages, per service: running ones and retry delays.
const pageReads = new WeakMap();
function readsOf(service) {
  if (!pageReads.has(service))
    pageReads.set(
      service,
      historyReads({ now: () => (service.now ? service.now() : Date.now()) }),
    );
  return pageReads.get(service);
}
export async function conversationHistory(service, id, { before, limit = 100 } = {}) {
  const conversation = service.store.getConversation(id);
  const offset = before ? Number(before) : 0;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw assistantProblem("invalid");
  let messages = service.store.messages(id),
    nextBefore = null,
    stale = true;
  const client = service.runtime.client;
  const maintenanceEpoch = service.maintenanceEpoch || 0;
  const generation = service.runtime.generation;
  if (client?.ready && !service.maintenance && !service.recovering) {
    try {
      const history = await client.call("chat.history", {
        sessionKey: conversation.runtimeSessionKey,
        limit,
        offset,
      });
      // The page cuts every text at OpenClaw's 8000 characters; cut ones are
      // completed from the cache or read on their own (history-text.js).
      const page = await completePage(publicMessages(history.messages), {
        known: new Map(messages.map((m) => [m.id, m])),
        read: (messageId) => conversationMessage(service, id, messageId),
        reads: readsOf(service),
        scope: id,
      });
      if (
        service.maintenance ||
        service.recovering ||
        service.closed ||
        (service.maintenanceEpoch || 0) !== maintenanceEpoch ||
        service.runtime.generation !== generation ||
        service.runtime.client !== client
      )
        throw assistantProblem("unavailable", 503);
      const merged = new Map(messages.map((m) => [m.id, m]));
      for (const m of page) merged.set(m.id, m);
      const cached = cachedWindow(
        [...merged.values()].sort((a, b) => a.timestamp - b.timestamp),
      );
      // The chat polls every 2 s during a run; an unchanged page writes nothing.
      if (
        cached.length !== messages.length ||
        cached.some((m, i) => !sameMessage(m, messages[i]))
      )
        service.store.cacheMessages(id, cached);
      messages = page;
      stale = false;
      if (history.hasMore)
        nextBefore = String(offset + (history.messages?.length || limit));
    } catch {
      /* Last known history stays available when Gateway connectivity is lost. */
    }
  }
  if (stale) {
    const end = Math.max(0, messages.length - offset);
    messages = messages.slice(Math.max(0, end - limit), end);
    if (end > limit) nextBefore = String(offset + limit);
  }
  const files = service.attachments?.forConversation(id) || new Map();
  const requests = requestsWithAttachments(
    service.ledger
      .requests(id)
      .map((r) => ({ ...r, attempt: service.ledger.attemptFor(r.id) })),
    files,
  );
  // One trusted-context lookup per request and one attempt query per history read.
  const contexts = new Map(
    service.teams ? requests.map((r) => [r.id, service.teams.store.context(r.id)]) : [],
  );
  const attempts = service.ledger.attemptRequests(id);
  messages = withAttachments(withoutMarks(messages), requests, {
    attempts,
    byRequest: files,
  });
  const visible = hideInternal(messages, requests, contexts, attempts);
  return {
    ...visible,
    requests: requestsWithSources(visible.requests, contexts),
    messages: withMemoryNotes(
      withRoutineResults(
        withRunNotes(
          service,
          conversation,
          withMessageSources(visible.messages, requests, { attempts, contexts }),
          nextBefore,
        ),
        service.routines?.results.forConversation(id) || [],
        { from: pageStart(nextBefore, messages) },
      ),
      service.memoryNotes?.forConversation(id) || [],
      { from: pageStart(nextBefore, messages) },
    ),
    nextBefore,
    stale,
  };
}
const pageStart = (nextBefore, messages) =>
  nextBefore && messages.length ? messages[0].timestamp : -Infinity;
// Coding and SSH run notes join the page they fall into. A page reaches from its first
// message (or the very start when no earlier page exists) to the present; the
// client keeps the newer copy of a note that an older page repeats.
function withRunNotes(service, conversation, messages, nextBefore) {
  const actions = service.workflows?.store.list(conversation.assistantId) || [];
  const from = nextBefore && messages.length ? messages[0].timestamp : -Infinity;
  const notes = actionNotes(actions, conversation.id).filter((n) => n.timestamp >= from);
  if (!notes.length) return messages;
  return [...messages, ...notes]
    .map((m, i) => [m, i])
    .sort(([x, i], [y, j]) => x.timestamp - y.timestamp || i - j)
    .map(([m]) => m);
}
