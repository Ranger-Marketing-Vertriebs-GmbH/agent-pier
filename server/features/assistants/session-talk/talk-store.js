// The log of messages between coding sessions and agents (session_talk, on the
// assistants DB): one row per ask, tell, send, late answer or noted limit. The row
// body is the record; the columns only serve lookups and pruning. `open` marks the
// rows the scheduler still has to advance (pending), so its 1 s pass reads only
// those through a partial index instead of parsing the whole table.
import { randomUUID } from "node:crypto";

const day = 24 * 60 * 60 * 1000;
const keepMs = 30 * day;
const keepPerAgent = 500;
// The ops a chat shows as notes (talk-notes.js).
const noted = ["send", "late", "limit"];

const parse = (row) => (row ? JSON.parse(row.body) : null);

/** A turn still to deliver, or a late answer waiting to settle. */
const isOpen = (row) =>
  row.direction === "to-agent" &&
  (["queued", "running"].includes(row.phase) ||
    (row.op === "ask" &&
      row.late === true &&
      ["answered", "failed"].includes(row.phase)));

// The lookup columns, each with the expression that backfills it from the body of a
// row written before the column existed.
const flag = (path) => `coalesce(json_extract(body,'$.${path}')=1,0)`;
const columns = {
  op: ["TEXT", "json_extract(body,'$.op')"],
  direction: ["TEXT", "json_extract(body,'$.direction')"],
  phase: ["TEXT", "json_extract(body,'$.phase')"],
  late: ["INTEGER", flag("late")],
  inline: ["INTEGER", flag("inline")],
  open: [
    "INTEGER",
    `coalesce(json_extract(body,'$.direction')='to-agent' AND (json_extract(body,'$.phase') IN ('queued','running') OR (json_extract(body,'$.op')='ask' AND ${flag("late")} AND json_extract(body,'$.phase') IN ('answered','failed'))),0)`,
  ],
};
const values = (row) => [
  row.op ?? null,
  row.direction ?? null,
  row.phase ?? null,
  row.late === true ? 1 : 0,
  row.inline === true ? 1 : 0,
  isOpen(row) ? 1 : 0,
];

function migrate(db) {
  db.exec(
    `CREATE TABLE IF NOT EXISTS session_talk (id TEXT PRIMARY KEY, assistant_id TEXT, session_id TEXT, conversation_id TEXT, created_at INTEGER, body TEXT, ${Object.entries(
      columns,
    )
      .map(([name, [type]]) => `"${name}" ${type}`)
      .join(", ")})`,
  );
  const have = new Set(
    db
      .prepare("PRAGMA table_info(session_talk)")
      .all()
      .map((c) => c.name),
  );
  const missing = Object.keys(columns).filter((name) => !have.has(name));
  if (missing.length) {
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const name of missing)
        db.exec(`ALTER TABLE session_talk ADD COLUMN "${name}" ${columns[name][0]}`);
      // Rows written before the columns existed take their values from the body.
      const set = missing.map((name) => `"${name}"=${columns[name][1]}`);
      db.exec(`UPDATE session_talk SET ${set.join(", ")}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS session_talk_pair ON session_talk(session_id, assistant_id, created_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS session_talk_conversation ON session_talk(conversation_id, created_at)",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS session_talk_open ON session_talk(created_at) WHERE open=1",
  );
}

export class TalkStore {
  constructor(db, now = Date.now) {
    this.db = db;
    this.now = now;
    migrate(db);
  }
  create(fields) {
    const createdAt = fields.createdAt ?? this.now();
    const row = { ...fields, id: fields.id ?? randomUUID(), createdAt };
    this.db
      .prepare(
        'INSERT INTO session_talk (id, assistant_id, session_id, conversation_id, created_at, body, op, direction, phase, late, "inline", open) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        row.id,
        row.assistantId ?? null,
        row.sessionId ?? null,
        row.conversationId ?? null,
        createdAt,
        JSON.stringify(row),
        ...values(row),
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
      .prepare(
        'UPDATE session_talk SET conversation_id=?, body=?, op=?, direction=?, phase=?, late=?, "inline"=?, open=? WHERE id=?',
      )
      .run(next.conversationId ?? null, JSON.stringify(next), ...values(next), id);
    return next;
  }
  delete(id) {
    this.db.prepare("DELETE FROM session_talk WHERE id=?").run(id);
  }
  /** Turns still to deliver, and late answers waiting to settle. */
  pending() {
    return this.db
      .prepare("SELECT body FROM session_talk WHERE open=1 ORDER BY created_at, rowid")
      .all()
      .map(parse);
  }
  /** Asks no waiter handed over and none marked late: after a restart, nobody holds them. */
  unclaimedAsks() {
    return this.db
      .prepare(
        `SELECT body FROM session_talk WHERE op='ask' AND direction='to-agent' AND "inline"=0 AND late=0 AND phase IN ('queued','running','answered','failed') AND created_at>=? ORDER BY created_at, rowid`,
      )
      .all(this.now() - keepMs)
      .map(parse);
  }
  /** The rows a chat shows as notes (sends, late answers, limits) within the keep window. */
  forConversation(conversationId) {
    return this.db
      .prepare(
        `SELECT body FROM session_talk WHERE conversation_id=? AND created_at>=? AND op IN (${noted.map(() => "?").join(",")}) ORDER BY created_at, rowid`,
      )
      .all(conversationId, this.now() - keepMs, ...noted)
      .map(parse);
  }
  /** Asks, tells and sends of one pair since a time (both directions; late answers and limit notes are other ops). */
  pairCount({ sessionId, assistantId, since }) {
    const times = this.db
      .prepare(
        "SELECT created_at FROM session_talk WHERE session_id=? AND assistant_id=? AND created_at>=? AND op IN ('ask','tell','send') ORDER BY created_at, rowid",
      )
      .all(sessionId, assistantId, since)
      .map((row) => row.created_at);
    return { count: times.length, oldest: times[0] ?? null, times };
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
