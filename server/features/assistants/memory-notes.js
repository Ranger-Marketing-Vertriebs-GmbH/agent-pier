// Quiet chat lines for memory that an agent could not write: a refused write to
// MEMORY.md or memory/ (team-bridge.js) or an owner turn that ran before the write
// guard was back (write-guard-wait.js). "shared-write" marks a saved write to a shared
// agent's memory in the writing user's chat: it applies to all its users. The chat
// translates `reason`.
export const memoryNoteReasons = [
  "guard-pending",
  "not-owner",
  "forwarded",
  "automatic",
  "lead-request",
  "flush",
  "shared-write",
];
const kept = 100;

export class MemoryNotes {
  constructor(db, now = Date.now) {
    Object.assign(this, { db, now });
    db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_memory_notes (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, body TEXT NOT NULL)",
    );
  }
  /** One note per key (a turn and reason): a repeated refusal keeps the first. */
  record({ key, conversationId, reason }) {
    if (!memoryNoteReasons.includes(reason)) throw Error(`Unknown memory note ${reason}`);
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO assistant_memory_notes VALUES(?,?,?)")
      .run(key, conversationId, JSON.stringify({ reason, at: this.now() }));
    if (inserted.changes)
      this.db
        .prepare(
          "DELETE FROM assistant_memory_notes WHERE conversation_id=? AND rowid NOT IN (SELECT rowid FROM assistant_memory_notes WHERE conversation_id=? ORDER BY rowid DESC LIMIT ?)",
        )
        .run(conversationId, conversationId, kept);
    return inserted.changes === 1;
  }
  forConversation(conversationId) {
    return this.db
      .prepare(
        "SELECT id, body FROM assistant_memory_notes WHERE conversation_id=? ORDER BY rowid",
      )
      .all(conversationId)
      .map((row) => {
        const { reason, at } = JSON.parse(row.body);
        return {
          id: `memory-note:${row.id}`,
          role: "event",
          event: "memory-note",
          reason,
          timestamp: at,
          runId: null,
        };
      });
  }
}

/** Like coding run notes, a note joins the history page it falls into. */
export function withMemoryNotes(messages, notes, { from = -Infinity } = {}) {
  const own = notes.filter((n) => n.timestamp >= from);
  if (!own.length) return messages;
  return [...messages, ...own]
    .map((m, i) => [m, i])
    .sort(([x, i], [y, j]) => x.timestamp - y.timestamp || i - j)
    .map(([m]) => m);
}
