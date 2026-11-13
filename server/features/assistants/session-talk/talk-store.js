// The log of messages between coding sessions and agents (session_talk, on the
// assistants DB): one row per ask, tell, send, late answer or noted limit. The row
// body is the record; the columns only serve lookups and pruning.
import { randomUUID } from "node:crypto";

const day = 24 * 60 * 60 * 1000;
const keepMs = 30 * day;
const keepPerAgent = 500;
const counted = new Set(["ask", "tell", "send"]);

const parse = (row) => (row ? JSON.parse(row.body) : null);

export class TalkStore {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
    db.exec(
      "CREATE TABLE IF NOT EXISTS session_talk (id TEXT PRIMARY KEY, assistant_id TEXT, session_id TEXT, conversation_id TEXT, created_at INTEGER, body TEXT)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS session_talk_pair ON session_talk(session_id, assistant_id, created_at)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS session_talk_conversation ON session_talk(conversation_id, created_at)",
    );
  }
  create(fields) {
    const createdAt = fields.createdAt ?? this.now();
    const row = { ...fields, id: fields.id ?? randomUUID(), createdAt };
    this.db
      .prepare(
        "INSERT INTO session_talk (id, assistant_id, session_id, conversation_id, created_at, body) VALUES (?,?,?,?,?,?)",
      )
      .run(
        row.id,
        row.assistantId ?? null,
        row.sessionId ?? null,
        row.conversationId ?? null,
        createdAt,
        JSON.stringify(row),
      );
    return row;
  }
  get(id) {
    return parse(this.db.prepare("SELECT body FROM session_talk WHERE id=?").get(id));
  }
  patch(id, fields) {
    const row = this.get(id);
    if (!row) return null;
    const next = { ...row, ...fields, id: row.id };
    this.db
      .prepare("UPDATE session_talk SET conversation_id=?, body=? WHERE id=?")
      .run(next.conversationId ?? null, JSON.stringify(next), id);
    return next;
  }
  /** Turns still to deliver, and late answers waiting to settle. */
  pending() {
    return this.db
      .prepare("SELECT body FROM session_talk ORDER BY created_at, rowid")
      .all()
      .map(parse)
      .filter(
        (row) =>
          row.direction === "to-agent" &&
          (["queued", "running"].includes(row.phase) ||
            (row.op === "ask" &&
              row.late === true &&
              ["answered", "failed"].includes(row.phase))),
      );
  }
  /** Asks no waiter handed over and none marked late: after a restart, nobody holds them. */
  unclaimedAsks() {
    return this.db
      .prepare(
        "SELECT body FROM session_talk WHERE created_at>=? ORDER BY created_at, rowid",
      )
      .all(this.now() - keepMs)
      .map(parse)
      .filter(
        (row) =>
          row.op === "ask" &&
          row.direction === "to-agent" &&
          !row.inline &&
          !row.late &&
          ["queued", "running", "answered", "failed"].includes(row.phase),
      );
  }
  forConversation(conversationId) {
    return this.db
      .prepare(
        "SELECT body FROM session_talk WHERE conversation_id=? ORDER BY created_at, rowid",
      )
      .all(conversationId)
      .map(parse);
  }
  /** Asks, tells and sends of one pair since a time (both directions; late answers and limit notes are other ops). */
  pairCount({ sessionId, assistantId, since }) {
    const rows = this.db
      .prepare(
        "SELECT body FROM session_talk WHERE session_id=? AND assistant_id=? AND created_at>=? ORDER BY created_at",
      )
      .all(sessionId, assistantId, since)
      .map(parse)
      .filter((row) => counted.has(row.op));
    return {
      count: rows.length,
      oldest: rows.length ? rows[0].createdAt : null,
      times: rows.map((row) => row.createdAt),
    };
  }
  prune() {
    this.db
      .prepare("DELETE FROM session_talk WHERE created_at<?")
      .run(this.now() - keepMs);
    this.db
      .prepare(
        "DELETE FROM session_talk WHERE id IN (SELECT id FROM (SELECT id, ROW_NUMBER() OVER (PARTITION BY assistant_id ORDER BY created_at DESC, rowid DESC) AS n FROM session_talk) WHERE n>?)",
      )
      .run(keepPerAgent);
  }
}
