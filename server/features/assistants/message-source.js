// Where an owner turn of an AgentPier conversation came from, for the chat to show.
//
// Every user turn of an AgentPier conversation is submitted through the request
// ledger, and the trusted context recorded with each request says who submitted it.
// The only Telegram path into these conversations is AgentPier's own bot
// (assistant-channels/telegram-ingress.js): it admits only the paired owner's private
// chat and re-checks the paired chat and user before dispatching. Messages to an
// agent's own bot for other people (openclaw-config/telegram-senders.js) run in
// OpenClaw's per-sender sessions and never reach an AgentPier conversation.
//
// OpenClaw 2026.9.8 stores a `sessions.send` turn with the idempotency key
// `<run id>:user` (the run id is the key AgentPier sent: the attempt id), at the top
// level and in `__openclaw`, and keeps the sent text unchanged. That key links a
// history message to its attempt and so to its request; the contract checks it
// (tests/helpers/assistant-channel-contract.js).
//
// The browser gets `{ source: "telegram", sender: { kind: "owner" } }` (plus
// `forwarded: true` for a forwarded message) and nothing else: never a Telegram
// user, chat or channel id.
//
// A question or task a lead agent sent to its member (lead-requests.js) is recorded
// with the lead's name and the bare text the lead wrote; the member's chat shows that
// text with `{ source: "lead", sender: { kind: "agent", name } }` instead of the
// framing AgentPier added for the model.

/** The delivery key of a raw OpenClaw user message (`<run id>:user`), or null. */
export function turnKey(message) {
  const key = message?.idempotencyKey ?? message?.__openclaw?.idempotencyKey;
  if (typeof key !== "string" || !key.endsWith(":user")) return null;
  return key.slice(0, -":user".length) || null;
}

/** The public source of a request's trusted context, or null for any other turn. */
export function requestSource(context) {
  if (!context || typeof context !== "object") return null;
  // A forwarded Telegram message is the owner's to read, not the owner's request:
  // the chat shows no member chips on it.
  if (context.kind === "telegram")
    return {
      source: "telegram",
      sender: { kind: "owner" },
      ...(context.forwarded ? { forwarded: true } : {}),
    };
  if (
    context.kind === "lead-request" &&
    typeof context.leadName === "string" &&
    typeof context.display === "string"
  )
    return {
      source: "lead",
      sender: { kind: "agent", name: context.leadName },
      text: context.display,
    };
  return null;
}

// Line endings and trailing whitespace may differ between the stored request and the
// transcript; nothing else may.
const normalized = (text) => text.replace(/\r\n?/g, "\n").trimEnd();

/**
 * Adds `source` and `sender` to user messages a Telegram request submitted and drops
 * the internal `turnKey`. A message with a delivery key belongs to the request whose
 * attempt sent it (`attempts`: delivery key → request id). Without a key it belongs
 * to the newest request accepted at or before it (OpenClaw stamps the entry after
 * AgentPier accepted the request, on the same clock), and only when the texts are
 * equal. `contexts` maps a request id to its trusted context.
 */
export function withMessageSources(
  messages,
  requests,
  { attempts = new Map(), contexts },
) {
  const byId = new Map(requests.map((request) => [request.id, request]));
  const accepted = requests
    .map((request) => ({ request, at: Date.parse(request.createdAt) }))
    .filter(({ request, at }) => Number.isFinite(at) && typeof request.text === "string")
    .sort((a, b) => a.at - b.at);
  return messages.map(({ turnKey: key, ...message }) => {
    if (message.role !== "user" || typeof message.text !== "string") return message;
    const request = key
      ? byId.get(attempts.get(key))
      : byText(accepted, message.text, message.timestamp);
    const source = request && requestSource(contexts.get(request.id));
    return source ? { ...message, ...source } : message;
  });
}

function byText(accepted, text, timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  const latest = newestBefore(accepted, timestamp);
  return latest && normalized(latest.text) === normalized(text) ? latest : null;
}

// Binary search: the last request accepted at or before `limit`.
function newestBefore(accepted, limit) {
  let low = 0,
    high = accepted.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (accepted[middle].at <= limit) low = middle + 1;
    else high = middle;
  }
  return low ? accepted[low - 1].request : null;
}

/** The public request list with each Telegram request's source. */
export function requestsWithSources(requests, contexts) {
  return requests.map((request) => {
    const source = requestSource(contexts.get(request.id));
    return source ? { ...request, ...source } : request;
  });
}
