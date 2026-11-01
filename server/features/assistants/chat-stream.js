// The browser receives at most this much of a streamed reply; the history has it all.
export const maxStreamText = 65536;
// Runs whose terminal frame never arrives are forgotten oldest first.
const maxRuns = 64;

/**
 * The reply so far after one run event's `reply` (runtimes/agent-runtime.js), or
 * undefined when it cannot be placed: its `text` when it carries the whole reply (a
 * snapshot), else its `delta` appended to `previous` (or `delta` alone with
 * `replace`). A reply without either keeps `previous`.
 */
export function nextChatText(previous, reply) {
  if (typeof reply?.text === "string") return reply.text;
  const delta = reply?.delta;
  if (typeof delta !== "string") return previous;
  if (reply.replace === true) return delta;
  return previous === undefined ? undefined : previous + delta;
}

/** Accumulates each streaming run's reply, keyed by run as the runtime does. */
export class ChatStreams {
  constructor() {
    this.runs = new Map();
  }
  /**
   * Takes one run event (its `runId`, `sessionKey` and `reply`). Returns the reply so
   * far, or undefined while the run's snapshot is missing.
   */
  delta(event) {
    const current = this.runs.get(event.runId);
    const previous = current?.sessionKey === event.sessionKey ? current.text : undefined;
    const text = nextChatText(previous, event.reply);
    if (text === undefined) return undefined;
    this.runs.delete(event.runId);
    this.runs.set(event.runId, {
      sessionKey: event.sessionKey,
      text: text.slice(0, maxStreamText),
    });
    if (this.runs.size > maxRuns) this.runs.delete(this.runs.keys().next().value);
    return text.slice(0, maxStreamText);
  }
  /** A finished run's text is history now. */
  end(runId) {
    this.runs.delete(runId);
  }
  /** A new connection starts every run with a snapshot again. */
  clear() {
    this.runs.clear();
  }
}
