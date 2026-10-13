// The browser receives at most this much of a streamed reply; the history has it all.
export const maxStreamText = 65536;
// Runs whose terminal frame never arrives are forgotten oldest first.
const maxRuns = 64;

const isRecord = (value) => typeof value === "object" && value !== null;

// The text of a snapshot `message`, or undefined when it carries no text at all.
function messageText(message) {
  if (!isRecord(message)) return undefined;
  if (typeof message.content === "string") return message.content;
  const blocks = Array.isArray(message.content)
    ? message.content.filter((c) => c?.type === "text" && typeof c.text === "string")
    : [];
  return blocks.length ? blocks.map((c) => c.text).join("") : undefined;
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
  const snapshot = messageText(payload.message);
  if (snapshot !== undefined) return snapshot;
  const delta = payload.deltaText;
  if (typeof delta !== "string") return previous;
  if (payload.replace === true) return delta;
  return previous === undefined ? undefined : previous + delta;
}

/** Accumulates each streaming run's reply, keyed by run as the Gateway does. */
export class ChatStreams {
  constructor() {
    this.runs = new Map();
  }
  /** Returns the reply so far, or undefined while the run's snapshot is missing. */
  delta(payload) {
    const current = this.runs.get(payload.runId);
    const previous =
      current?.sessionKey === payload.sessionKey ? current.text : undefined;
    const text = nextChatText(previous, payload);
    if (text === undefined) return undefined;
    this.runs.delete(payload.runId);
    this.runs.set(payload.runId, {
      sessionKey: payload.sessionKey,
      text: text.slice(0, maxStreamText),
    });
    if (this.runs.size > maxRuns) this.runs.delete(this.runs.keys().next().value);
    return text.slice(0, maxStreamText);
  }
  /** A finished run's text is history now. */
  end(runId) {
    this.runs.delete(runId);
  }
  /** A new Gateway connection starts every run with a snapshot again. */
  clear() {
    this.runs.clear();
  }
}
