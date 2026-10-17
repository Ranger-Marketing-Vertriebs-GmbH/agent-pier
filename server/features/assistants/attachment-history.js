// The owner's attachments in the agent chat history.
//
// The agent receives the owner's text followed by a note naming the saved copies
// (agent-attachments.js). OpenClaw keeps that sent text unchanged, so the chat strips
// the note again and shows the files instead. A history message belongs to a request
// through its delivery key (message-source.js), or, without one, through the exact
// text that request sent.

const normalized = (text) => text.replace(/\r\n?/g, "\n").trimEnd();
const sentText = (request, note) =>
  normalized(request.text.trim() ? `${request.text}\n\n${note}` : note);

/**
 * Replaces the note in user messages with `attachments` (public file records).
 * `attempts` maps delivery keys to request ids; `byRequest` maps request ids to
 * `{ files, note }`. The internal `turnKey` stays for later steps.
 */
export function withAttachments(messages, requests, { attempts, byRequest }) {
  if (!byRequest.size) return messages;
  const byId = new Map(requests.map((request) => [request.id, request]));
  const sent = requests
    .filter((request) => byRequest.has(request.id) && typeof request.text === "string")
    .map((request) => [sentText(request, byRequest.get(request.id).note), request.id]);
  return messages.map((message) => {
    if (message.role !== "user" || typeof message.text !== "string") return message;
    const text = normalized(message.text);
    const requestId = message.turnKey
      ? attempts.get(message.turnKey)
      : sent.find(([candidate]) => candidate === text)?.[1];
    const entry = requestId && byRequest.get(requestId);
    if (!entry) return message;
    if (text.endsWith(entry.note))
      return {
        ...message,
        text: text.slice(0, text.length - entry.note.length).trimEnd(),
        attachments: entry.files,
      };
    // A turn cut before its note's end (over AgentPier's history limit, or not yet
    // read whole) still shows its files; it stays incomplete only when the owner's
    // own words were cut too.
    const incomplete = message.cut === true || message.partial === true;
    const request = byId.get(requestId);
    if (!incomplete || typeof request?.text !== "string") return message;
    const words = normalized(request.text);
    const { cut, partial, ...rest } = message;
    return {
      ...rest,
      text: text.slice(0, words.length).trimEnd(),
      attachments: entry.files,
      ...(text.length < words.length && (cut ? { cut } : { partial })),
    };
  });
}

/**
 * Files an agent shared (AgentAttachments.sharedFor) join the page they fall into as
 * agent messages, like the chat's other notes; the chat shows them at once, even
 * while the turn that shared them still runs.
 */
export function withSharedFiles(messages, shared, { from = -Infinity } = {}) {
  const own = shared.filter((m) => m.timestamp >= from);
  if (!own.length) return messages;
  return [...messages, ...own]
    .map((m, i) => [m, i])
    .sort(([x, i], [y, j]) => x.timestamp - y.timestamp || i - j)
    .map(([m]) => m);
}

/** Requests carry their files so a turn still in flight shows them too. */
export function requestsWithAttachments(requests, byRequest) {
  if (!byRequest.size) return requests;
  return requests.map((request) =>
    byRequest.has(request.id)
      ? { ...request, attachments: byRequest.get(request.id).files }
      : request,
  );
}
