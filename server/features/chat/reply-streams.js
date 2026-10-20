// Reply text a session's CLI is generating right now, for its open chats. Provider
// neutral: the Codex proxy, the OpenCode plugin and Claude's MessageDisplay hook all
// end in streamText(). Nothing is stored on disk; a run lives until it ends, its
// session's next turn starts, or it has been quiet for `idleMs`.
//
// A subscriber gets `{type: "stream", runId, from, text, thread?, turn?, order?}`
// frames: `from: 0` carries the whole text so far (a new subscriber, a rewrite),
// any other `from` appends where that subscriber's copy ends. `{type: "stream-end",
// runId}` says the run is over; its text is in the transcript (or never will be).
import { maxReplyText } from "../requests/native-push.js";

export class ReplyStreams {
  constructor({
    maxText = maxReplyText,
    maxRuns = 8,
    idleMs = 120000,
    flushMs = 40,
    onEnd = () => {},
  } = {}) {
    Object.assign(this, { maxText, maxRuns, idleMs, flushMs, onEnd });
    this.sessions = new Map();
    this.epochs = 0;
    this.closed = false;
  }
  entry(sessionId, create = true) {
    let entry = this.sessions.get(sessionId);
    if (!entry && create && !this.closed) {
      entry = { runs: new Map(), subscribers: new Set(), timer: null, idle: null };
      this.sessions.set(sessionId, entry);
    }
    return entry;
  }
  /** `send` gets every run's text so far at once, then what is appended. */
  subscribe(sessionId, send) {
    const entry = this.entry(sessionId);
    if (!entry) return () => {};
    const subscriber = { send, sent: new Map() };
    entry.subscribers.add(subscriber);
    for (const [runId, run] of entry.runs) this.streamTo(subscriber, runId, run);
    return () => {
      entry.subscribers.delete(subscriber);
      this.release(sessionId, entry);
    };
  }
  /**
   * The provider-neutral entry point. `{text}` (or `from: 0`) is the run's whole
   * text so far; `{text, from}` appends `text` at offset `from` and is ignored
   * when it does not continue the held text. `thread`, `turn` and `order` label
   * the run for the browser's reconciliation with the transcript. Returns whether
   * the text was taken.
   */
  streamText(sessionId, runId, { text, from = 0, thread, turn, order } = {}) {
    if (typeof runId !== "string" || !runId || typeof text !== "string") return false;
    const entry = this.entry(sessionId);
    if (!entry) return false;
    let run = entry.runs.get(runId);
    let next;
    if (from === 0) next = text;
    else if (run && run.length === from) next = run.text + text;
    else return false;
    // The cap holds the first part; the transcript brings the whole reply.
    const length = from + text.length;
    next = next.slice(0, this.maxText);
    if (!run || !next.startsWith(run.text)) {
      entry.runs.delete(runId);
      run = { text: next, epoch: ++this.epochs };
      entry.runs.set(runId, run);
      while (entry.runs.size > this.maxRuns)
        this.endStream(sessionId, entry.runs.keys().next().value, { quiet: true });
    } else run.text = next;
    run.length = length;
    for (const [key, value] of Object.entries({ thread, turn, order }))
      if (value !== undefined) run[key] = value;
    run.at = Date.now();
    this.schedule(entry);
    this.keepAlive(sessionId, entry);
    return true;
  }
  /** Run `runId` ended; with `turn` instead, every run of that turn did. */
  endStream(sessionId, runId, { turn, quiet = false } = {}) {
    const entry = this.entry(sessionId, false);
    if (!entry) return;
    const ended = runId
      ? entry.runs.has(runId)
        ? [runId]
        : []
      : [...entry.runs].filter(([, run]) => !turn || run.turn === turn).map(([id]) => id);
    for (const id of ended) {
      const run = entry.runs.get(id);
      entry.runs.delete(id);
      for (const subscriber of entry.subscribers) {
        // Text still waiting for the coalesced flush goes out first, also for a run
        // this subscriber has not seen yet: Claude Code reports a short last message
        // and the turn's Stop within milliseconds. An evicted run stays unseen.
        if (subscriber.sent.has(id) || (!quiet && run.text))
          this.streamTo(subscriber, id, run);
        if (subscriber.sent.delete(id))
          subscriber.send({ type: "stream-end", runId: id });
      }
    }
    if (ended.length && !quiet) this.onEnd(sessionId);
    this.release(sessionId, entry);
  }
  /** The runs of a session, as {runId: {text, ...labels}} (tests, diagnostics). */
  runs(sessionId) {
    const entry = this.entry(sessionId, false);
    return Object.fromEntries(
      [...(entry?.runs || [])].map(([id, run]) => [
        id,
        { text: run.text, turn: run.turn, thread: run.thread, order: run.order },
      ]),
    );
  }
  schedule(entry) {
    if (entry.timer) return;
    // Token-sized appends are coalesced into one frame per subscriber.
    entry.timer = setTimeout(() => {
      entry.timer = null;
      for (const subscriber of entry.subscribers)
        for (const [runId, run] of entry.runs) this.streamTo(subscriber, runId, run);
    }, this.flushMs);
    entry.timer.unref?.();
  }
  streamTo(subscriber, runId, run) {
    const sent = subscriber.sent.get(runId);
    const from = sent?.epoch === run.epoch ? sent.length : 0;
    if (sent?.epoch === run.epoch && run.text.length <= from) return;
    subscriber.sent.set(runId, { epoch: run.epoch, length: run.text.length });
    subscriber.send({
      type: "stream",
      runId,
      from,
      text: run.text.slice(from),
      ...(run.thread ? { thread: run.thread } : {}),
      ...(run.turn ? { turn: run.turn } : {}),
      ...(Number.isInteger(run.order) ? { order: run.order } : {}),
    });
  }
  // A CLI that died mid-reply never ends its runs: quiet runs expire.
  keepAlive(sessionId, entry) {
    clearTimeout(entry.idle);
    entry.idle = setTimeout(() => {
      const stale = Date.now() - this.idleMs;
      for (const [runId, run] of [...entry.runs])
        if (run.at <= stale) this.endStream(sessionId, runId);
      if (entry.runs.size) this.keepAlive(sessionId, entry);
    }, this.idleMs);
    entry.idle.unref?.();
  }
  release(sessionId, entry) {
    if (entry.runs.size || entry.subscribers.size) return;
    clearTimeout(entry.timer);
    clearTimeout(entry.idle);
    if (this.sessions.get(sessionId) === entry) this.sessions.delete(sessionId);
  }
  close() {
    this.closed = true;
    for (const entry of this.sessions.values()) {
      clearTimeout(entry.timer);
      clearTimeout(entry.idle);
    }
    this.sessions.clear();
  }
}
