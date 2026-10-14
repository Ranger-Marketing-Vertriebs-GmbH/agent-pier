import { historyText } from "./history-text.js";
// What the agent's chat shows of its routines: a delivered result (badged with the
// routine's name) or a failed run (a quiet line). OpenClaw commits a delivered
// result into the conversation itself; this record only names it. A result that
// could not be committed is kept here with its text, so it still shows.
const kept = 200;
const turnText = (text) => String(text).replace(/\r\n?/g, "\n").trim();

export class RoutineResults {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_routine_results (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL)",
    );
  }
  /** Idempotent per run: a replayed completion keeps the first record. */
  record(entry) {
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO assistant_routine_results VALUES(?,?,?)")
      .run(entry.id, entry.conversationId, JSON.stringify(entry));
    if (inserted.changes)
      this.db
        .prepare(
          "DELETE FROM assistant_routine_results WHERE conversation_id=? AND rowid NOT IN (SELECT rowid FROM assistant_routine_results WHERE conversation_id=? ORDER BY rowid DESC LIMIT ?)",
        )
        .run(entry.conversationId, entry.conversationId, kept);
    return inserted.changes === 1;
  }
  forConversation(conversationId) {
    return this.db
      .prepare(
        "SELECT body FROM assistant_routine_results WHERE conversation_id=? ORDER BY rowid",
      )
      .all(conversationId)
      .map((row) => JSON.parse(row.body));
  }
}

/**
 * Marks the committed results among `messages` with their routine and adds the
 * results and failures that live only here. Like coding run notes, an entry joins
 * the page it falls into: from the page's first message (or the very start) on.
 */
export function withRoutineResults(messages, results, { from = -Infinity } = {}) {
  if (!results.length) return messages;
  const committed = results.filter((r) => r.status === "ok" && r.committed);
  const marked = messages.map((m) => {
    if (m.role !== "assistant") return m;
    // The history page cuts a long reply; its kept beginning still identifies it.
    const shown = historyText(m.text);
    const same = (r) =>
      shown.cut
        ? !!turnText(shown.text) && turnText(r.text).startsWith(turnText(shown.text))
        : turnText(r.text) === turnText(m.text);
    const result = committed.findLast((r) => same(r) && !(m.timestamp < r.runAtMs));
    return result ? { ...m, scheduled: { name: result.name } } : m;
  });
  const own = results
    .filter((r) => r.at >= from && !(r.status === "ok" && r.committed))
    .map((r) =>
      r.status === "ok"
        ? {
            id: `routine:${r.id}`,
            role: "assistant",
            text: r.text,
            timestamp: r.at,
            runId: null,
            scheduled: { name: r.name },
          }
        : {
            id: `routine:${r.id}`,
            role: "event",
            event: "routine-failed",
            name: r.name,
            timestamp: r.at,
            runId: null,
          },
    );
  if (!own.length) return marked;
  return [...marked, ...own]
    .map((m, i) => [m, i])
    .sort(([x, i], [y, j]) => x.timestamp - y.timestamp || i - j)
    .map(([m]) => m);
}
