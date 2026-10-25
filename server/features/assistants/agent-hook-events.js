import { createHash, randomUUID } from "node:crypto";

const hour = 3600000;
const retention = 30 * 24 * hour;
const keptPayloads = 200;

const printable = (value) =>
  typeof value === "string" &&
  value.trim().length >= 1 &&
  value.trim().length <= 200 &&
  !/[\u0000-\u001f\u007f]/.test(value.trim());

/** The sender's own event id, else the SHA-256 of the body. */
export function eventIdOf({ headers = {}, text = "", json } = {}) {
  for (const name of ["idempotency-key", "x-event-id"]) {
    const value = headers[name];
    if (printable(value)) return value.trim();
  }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    for (const key of ["eventId", "id"]) {
      const value = json[key];
      if (printable(value)) return value.trim();
      if (Number.isSafeInteger(value)) return String(value);
    }
  }
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export class HookEvents {
  constructor(db, { now = Date.now } = {}) {
    this.db = db;
    this.now = now;
    db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_hook_events (id TEXT PRIMARY KEY, hook_id TEXT NOT NULL, assistant_id TEXT NOT NULL, event_id TEXT NOT NULL, received_at INTEGER NOT NULL, body TEXT NOT NULL, payload TEXT, UNIQUE(hook_id, event_id))",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS assistant_hook_events_assistant ON assistant_hook_events(assistant_id, received_at)",
    );
  }
  get(id) {
    const row = this.db
      .prepare("SELECT body FROM assistant_hook_events WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.body) : null;
  }
  find(hookId, eventId) {
    const row = this.db
      .prepare("SELECT body FROM assistant_hook_events WHERE hook_id=? AND event_id=?")
      .get(hookId, eventId);
    return row ? JSON.parse(row.body) : null;
  }
  /** The event of a native job; session keys may carry its id in another case. */
  byJob(jobId) {
    const row = this.db
      .prepare(
        "SELECT body FROM assistant_hook_events WHERE lower(json_extract(body,'$.jobId'))=lower(?)",
      )
      .get(jobId);
    return row ? JSON.parse(row.body) : null;
  }
  unsettled() {
    return this.db
      .prepare(
        "SELECT body FROM assistant_hook_events WHERE json_extract(body,'$.status') IN ('pending','running') ORDER BY received_at, rowid",
      )
      .all()
      .map((row) => JSON.parse(row.body));
  }
  admit(hook, { eventId, payload, size, contentType, source, test }) {
    const at = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.find(hook.id, eventId);
      let result;
      if (existing) {
        const event = this.write({ ...existing, duplicates: existing.duplicates + 1 });
        result = { event, outcome: "duplicate", firstThrottled: false };
      } else {
        const since = at - hour;
        const count = (status) =>
          this.db
            .prepare(
              `SELECT COUNT(*) AS n FROM assistant_hook_events WHERE hook_id=? AND received_at>? AND json_extract(body,'$.status') ${status}`,
            )
            .get(hook.id, since).n;
        const throttled = count("!= 'throttled'") >= hook.hourlyLimit;
        const firstThrottled = throttled && count("= 'throttled'") === 0;
        const event = {
          id: randomUUID(),
          hookId: hook.id,
          assistantId: hook.assistantId,
          eventId,
          receivedAt: at,
          size,
          contentType,
          source,
          status: throttled ? "throttled" : "pending",
          duplicates: 0,
          ...(test ? { test: true } : {}),
        };
        this.db
          .prepare(
            "INSERT INTO assistant_hook_events (id, hook_id, assistant_id, event_id, received_at, body, payload) VALUES (?,?,?,?,?,?,?)",
          )
          .run(
            event.id,
            hook.id,
            hook.assistantId,
            eventId,
            at,
            JSON.stringify(event),
            payload ?? null,
          );
        result = {
          event,
          outcome: throttled ? "throttled" : "fresh",
          firstThrottled,
        };
      }
      this.prune(hook.id);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  write(event) {
    this.db
      .prepare("UPDATE assistant_hook_events SET body=? WHERE id=?")
      .run(JSON.stringify(event), event.id);
    return event;
  }
  patch(id, fields) {
    const current = this.get(id);
    if (!current) throw new Error(`Unknown hook event ${id}`);
    return this.write({ ...current, ...fields, id: current.id });
  }
  remove(id) {
    this.db.prepare("DELETE FROM assistant_hook_events WHERE id=?").run(id);
  }
  forget(hookId) {
    this.db.prepare("DELETE FROM assistant_hook_events WHERE hook_id=?").run(hookId);
  }
  forAssistant(assistantId, { limit = 50 } = {}) {
    return this.db
      .prepare(
        "SELECT body FROM assistant_hook_events WHERE assistant_id=? ORDER BY received_at DESC, rowid DESC LIMIT ?",
      )
      .all(assistantId, limit)
      .map((row) => JSON.parse(row.body));
  }
  /** The hook's newest event, or null. */
  last(hookId) {
    const row = this.db
      .prepare(
        "SELECT body FROM assistant_hook_events WHERE hook_id=? ORDER BY received_at DESC, rowid DESC LIMIT 1",
      )
      .get(hookId);
    return row ? JSON.parse(row.body) : null;
  }
  payload(id) {
    const row = this.db
      .prepare("SELECT payload FROM assistant_hook_events WHERE id=?")
      .get(id);
    return row?.payload ?? null;
  }
  prune(hookId) {
    this.db
      .prepare("DELETE FROM assistant_hook_events WHERE hook_id=? AND received_at<?")
      .run(hookId, this.now() - retention);
    this.db
      .prepare(
        "UPDATE assistant_hook_events SET payload=NULL WHERE payload IS NOT NULL AND id IN (SELECT id FROM assistant_hook_events WHERE hook_id=? ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
      )
      .run(hookId, keptPayloads);
  }
}
