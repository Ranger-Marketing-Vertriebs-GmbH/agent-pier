// What happened to each push: one row per delivery attempt with its time, result and
// the push service's status code, and one row per device AgentPier removed. Both are
// bounded. They live in tables of their own, so a release from before them still
// reads and writes `deliveries` and `subscriptions` unchanged after a rollback.

/** Attempts kept per device, and how long any attempt is kept. */
export const attemptsPerDevice = 20;
export const attemptAgeMs = 30 * 24 * 60 * 60 * 1000;
/** Removed devices kept (all persons together). */
export const removalsKept = 50;

export class PushDeliveryLog {
  constructor(db, now) {
    this.db = db;
    this.now = now;
    db.exec(
      "CREATE TABLE IF NOT EXISTS delivery_log (subscription_id TEXT NOT NULL,event_id TEXT NOT NULL,kind TEXT NOT NULL,at TEXT NOT NULL,status TEXT NOT NULL,status_code INTEGER,failure TEXT); CREATE INDEX IF NOT EXISTS delivery_log_device ON delivery_log(subscription_id,at); CREATE TABLE IF NOT EXISTS device_removals (user_id TEXT,label TEXT NOT NULL,reason TEXT NOT NULL,at TEXT NOT NULL,status_code INTEGER);",
    );
  }
  /** One attempt: `sent`, or failed with the status code and the owner-facing text. */
  record(subscriptionId, eventId, kind, { sent, statusCode, failure }) {
    const at = this.now();
    this.db
      .prepare("INSERT INTO delivery_log VALUES(?,?,?,?,?,?,?)")
      .run(
        subscriptionId,
        eventId,
        kind,
        at,
        sent ? "sent" : "failed",
        Number.isSafeInteger(statusCode) ? statusCode : null,
        sent || typeof failure !== "string" ? null : failure,
      );
    this.db
      .prepare(
        "DELETE FROM delivery_log WHERE subscription_id=? AND rowid NOT IN (SELECT rowid FROM delivery_log WHERE subscription_id=? ORDER BY rowid DESC LIMIT ?)",
      )
      .run(subscriptionId, subscriptionId, attemptsPerDevice);
    const oldest = new Date(Date.parse(at) - attemptAgeMs).toISOString();
    this.db.prepare("DELETE FROM delivery_log WHERE at<?").run(oldest);
  }
  /** A device's last attempt, or null. */
  latest(subscriptionId) {
    const row = this.db
      .prepare(
        "SELECT kind,at,status,status_code,failure FROM delivery_log WHERE subscription_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(subscriptionId);
    if (!row) return null;
    return {
      at: row.at,
      status: row.status,
      kind: row.kind,
      ...(row.status_code === null ? {} : { statusCode: row.status_code }),
      ...(row.failure === null ? {} : { failure: row.failure }),
    };
  }
  forget(subscriptionId) {
    this.db
      .prepare("DELETE FROM delivery_log WHERE subscription_id=?")
      .run(subscriptionId);
  }
  /** A device that stopped receiving: who it was for, its name and why. */
  removed({ userId = null, label, reason, statusCode }) {
    this.db
      .prepare("INSERT INTO device_removals VALUES(?,?,?,?,?)")
      .run(
        userId,
        typeof label === "string" ? label : "",
        reason,
        this.now(),
        Number.isSafeInteger(statusCode) ? statusCode : null,
      );
    this.db
      .prepare(
        "DELETE FROM device_removals WHERE rowid NOT IN (SELECT rowid FROM device_removals ORDER BY rowid DESC LIMIT ?)",
      )
      .run(removalsKept);
  }
  /** This person's last removed device, or null. */
  lastRemoval(userId = null) {
    const row = this.db
      .prepare(
        "SELECT label,reason,at FROM device_removals WHERE user_id IS ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(userId);
    return row ? { label: row.label, reason: row.reason, at: row.at } : null;
  }
}
