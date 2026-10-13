function messageText(message) {
  if (typeof message?.content === "string") return message.content;
  return Array.isArray(message?.content)
    ? message.content
        .filter((c) => c?.type === "text" && typeof c.text === "string")
        .map((c) => c.text)
        .join("")
    : "";
}

/**
 * The reply so far after one Gateway `chat` delta frame, or undefined when the frame
 * cannot be placed. OpenClaw 2026.9.8 sends a run's first frame on a connection, and
 * any frame after a rewrite, as a snapshot whose `message` holds the whole reply; later
 * frames omit `message` and their `deltaText` holds only the appended text
 * (`replace: true` makes it the whole text instead). Mirrors the Gateway client's
 * mergeChatStreamMessage.
 */
export function nextChatText(previous, payload) {
  if (payload.message !== undefined) return messageText(payload.message);
  const delta = payload.deltaText;
  if (typeof delta !== "string") return previous;
  if (payload.replace === true) return delta;
  return previous === undefined ? undefined : previous + delta;
}

/** Accumulates the streamed reply of the current run per Gateway session. */
export class ChatStreams {
  constructor() {
    this.sessions = new Map();
  }
  /** Returns the reply so far, or undefined while the run's snapshot is missing. */
  delta(payload) {
    const current = this.sessions.get(payload.sessionKey);
    const previous = current?.runId === payload.runId ? current.text : undefined;
    const text = nextChatText(previous, payload);
    if (text === undefined) return undefined;
    this.sessions.set(payload.sessionKey, { runId: payload.runId, text });
    return text;
  }
  /** A finished run's text is history now; a newer run's stream is kept. */
  end(sessionKey, runId) {
    if (this.sessions.get(sessionKey)?.runId === runId) this.sessions.delete(sessionKey);
  }
}
