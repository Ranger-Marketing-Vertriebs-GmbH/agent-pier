import { createHash } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { codingRunNotes } from "./assistant-action-notifications.js";
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
    return [
      {
        id,
        role: m.role,
        text,
        timestamp: m.timestamp || 0,
        runId: m.__openclaw?.runId || null,
      },
    ];
  });
}
// Turns AgentPier itself submits for synthesis carry attributed reports, not owner
// words. The ledger keeps their exact text for audit; the visible history shows a
// compact event in their place.
const internalKinds = new Set(["team-result", "coding-result"]);
function hideInternal(service, messages, requests) {
  const internal = requests
    .map((r) => [r, service.teams?.store.context(r.id).kind])
    .filter(([, kind]) => internalKinds.has(kind));
  if (!internal.length) return { messages, requests };
  const kindOf = (text) =>
    internal.find(([r]) => text === r.text || text.endsWith(r.text))?.[1];
  return {
    messages: messages.map((m) => {
      const kind = m.role === "user" && kindOf(m.text);
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
      if (
        service.maintenance ||
        service.recovering ||
        service.closed ||
        (service.maintenanceEpoch || 0) !== maintenanceEpoch ||
        service.runtime.generation !== generation ||
        service.runtime.client !== client
      )
        throw assistantProblem("unavailable", 503);
      const page = publicMessages(history.messages);
      const merged = new Map(messages.map((m) => [m.id, m]));
      for (const m of page) merged.set(m.id, m);
      service.store.cacheMessages(
        id,
        [...merged.values()].sort((a, b) => a.timestamp - b.timestamp),
      );
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
  const requests = service.ledger
    .requests(id)
    .map((r) => ({ ...r, attempt: service.ledger.attemptFor(r.id) }));
  const visible = hideInternal(service, messages, requests);
  return {
    ...visible,
    messages: withRunNotes(service, conversation, visible.messages, nextBefore),
    nextBefore,
    stale,
  };
}
// Coding run notes join the page they fall into. A page reaches from its first
// message (or the very start when no earlier page exists) to the present; the
// client keeps the newer copy of a note that an older page repeats.
function withRunNotes(service, conversation, messages, nextBefore) {
  const actions = service.workflows?.store.list(conversation.assistantId) || [];
  const from = nextBefore && messages.length ? messages[0].timestamp : -Infinity;
  const notes = codingRunNotes(actions, conversation.id).filter(
    (n) => n.timestamp >= from,
  );
  if (!notes.length) return messages;
  return [...messages, ...notes]
    .map((m, i) => [m, i])
    .sort(([x, i], [y, j]) => x.timestamp - y.timestamp || i - j)
    .map(([m]) => m);
}
