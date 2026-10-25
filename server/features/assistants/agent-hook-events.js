import { createHash, randomUUID } from "node:crypto";

const hour = 3600000;
const retention = 30 * 24 * hour;
const keptPayloads = 200;
// The dedup key of an event whose run failed to start (HookEvents.tombstone).
const failedStart = "failed-start:";
const unsettledStatus = "json_extract(body,'$.status') IN ('pending','running')";
const jobKey = "lower(json_extract(body,'$.jobId'))";
// The hot lookups, each served by an index (byJob on every tool call and Gateway
// frame of a cron session, unsettled on every start and sweep, the hourly count on
// every admit). The expressions must match the index definitions exactly.
export const hookEventQueries = Object.freeze({
  byJob: `SELECT body FROM assistant_hook_events WHERE ${jobKey}=lower(?)`,
  unsettled: `SELECT body FROM assistant_hook_events WHERE ${unsettledStatus} ORDER BY received_at, rowid`,
  count: (status) =>
    `SELECT COUNT(*) AS n FROM assistant_hook_events WHERE hook_id=? AND received_at>? AND json_extract(body,'$.status') ${status}`,
});

const printable = (value) =>
  typeof value === "string" &&
  value.trim().length >= 1 &&
  value.trim().length <= 200 &&
  !/[\u0000-\u001f\u007f]/.test(value.trim());

// A usable sender id: printable and not in the tombstones' reserved key space.
const usable = (value) =>
  printable(value) && !value.trim().toLowerCase().startsWith(failedStart);

/** The sender's own event id, else the SHA-256 of the body. */
export function eventIdOf({ headers = {}, text = "", json } = {}) {
  for (const name of ["idempotency-key", "x-event-id"]) {
    const value = headers[name];
    if (usable(value)) return value.trim();
  }
  if (json && typeof json === "object" && !Array.isArray(json)) {
    for (const key of ["eventId", "id"]) {
      const value = json[key];
      if (usable(value)) return value.trim();
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
    // Tables of earlier builds gain these on open.
    db.exec(
      `CREATE INDEX IF NOT EXISTS assistant_hook_events_job ON assistant_hook_events(${jobKey})`,
    );
    db.exec(
      `CREATE INDEX IF NOT EXISTS assistant_hook_events_unsettled ON assistant_hook_events(received_at) WHERE ${unsettledStatus}`,
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS assistant_hook_events_hook ON assistant_hook_events(hook_id, received_at)",
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
    if (typeof jobId !== "string" || !jobId) return null;
    const row = this.db.prepare(hookEventQueries.byJob).get(jobId);
    return row ? JSON.parse(row.body) : null;
  }
  unsettled() {
    return this.db
      .prepare(hookEventQueries.unsettled)
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
          this.db.prepare(hookEventQueries.count(status)).get(hook.id, since).n;
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
  /**
   * An event whose start failed after its job existed: kept as a failed row with its
   * job id, so a run the Gateway may still have started stays a hook session without
   * rights (agent-hook-bridge.js). Its dedup key moves aside, so the sender's retry
   * is admitted fresh; like any event it counts toward the hourly limit (it may have
   * woken the agent) and ages out with the hook's other events.
   */
  tombstone(id, reason = { startFailed: true }) {
    const current = this.get(id);
    if (!current) return;
    const event = {
      ...current,
      ...reason,
      status: "failed",
      completedAt: this.now(),
    };
    this.db
      .prepare(
        "UPDATE assistant_hook_events SET event_id=?, body=?, payload=NULL WHERE id=?",
      )
      .run(`${failedStart}${id}`, JSON.stringify(event), id);
  }
  remove(id) {
    this.db.prepare("DELETE FROM assistant_hook_events WHERE id=?").run(id);
  }
  /**
   * A deleted hook's events. A run still unsettled with a job becomes a tombstone
   * without rights (`hookDeleted`), so its session stays a hook session
   * (agent-hook-bridge.js); tombstones age out with `expire`. Every other row goes.
   */
  forget(hookId) {
    for (const event of this.unsettled())
      if (event.hookId === hookId && event.jobId)
        this.tombstone(event.id, { hookDeleted: true });
    this.db
      .prepare(
        "DELETE FROM assistant_hook_events WHERE hook_id=? AND NOT (json_extract(body,'$.startFailed') IS 1 OR json_extract(body,'$.hookDeleted') IS 1)",
      )
      .run(hookId);
  }
  /** Rows of every hook past retention (deleted hooks no longer admit and prune). */
  expire() {
    this.db
      .prepare("DELETE FROM assistant_hook_events WHERE received_at<?")
      .run(this.now() - retention);
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
