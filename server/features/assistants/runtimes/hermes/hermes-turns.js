// Hermes's history rows name neither their turn's run nor its submission
// (hermes-sessions.js hermesEntry), but AgentPier finds a reply by its run: Telegram
// sends the reply of the run its input started (telegram-delivery.js), follow-ups and
// lead requests read theirs. The turns AgentPier submitted are known: each run id
// (the turn's `submission_id`) with the text it sent, in order per session. A user
// row with that text starts the run's turn; the assistant rows after it, up to the
// next user row, are its reply. Kept for the life of the AgentPier process across
// the agent's restarts; a turn sent before is not attributed, as before.

const keptTurns = 100;
const same = (a, b) => String(a ?? "").trim() === String(b ?? "").trim();

export class HermesTurns {
  constructor() {
    this.sessions = new Map();
  }

  /** Records run `runId` of session `key`, submitted with `text`. */
  record(key, runId, text) {
    if (typeof key !== "string" || typeof runId !== "string") return;
    const turns = (this.sessions.get(key) || []).filter((t) => t.runId !== runId);
    turns.push({ runId, text: String(text ?? "") });
    this.sessions.set(key, turns.slice(-keptTurns));
  }

  forget(key) {
    this.sessions.delete(key);
  }

  /** `messages` (oldest first, each with its `entry`) with the runs they belong to. */
  attribute(key, messages) {
    const turns = [...(this.sessions.get(key) || [])];
    if (!turns.length) return messages;
    let run = null;
    return messages.map((message) => {
      const entry = message?.entry;
      if (!entry) return message;
      if (entry.role === "user") {
        if (entry.internal) return message;
        const at = turns.findIndex((turn) => same(turn.text, entry.text));
        run = at < 0 ? null : turns[at].runId;
        if (at >= 0) turns.splice(0, at + 1);
        return message;
      }
      if (entry.role !== "assistant" || !run || entry.runId) return message;
      return { ...message, entry: { ...entry, runId: run } };
    });
  }
}
