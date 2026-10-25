import path from "node:path";
import { privateDatabase } from "../../lib/private-database.js";
import { assistantProblem } from "./assistant-validation.js";
import { validTimeZone } from "./heartbeat-schedule.js";

/**
 * The owner's switch for OpenClaw dreaming (memory-core's nightly sweep): on or off,
 * the hour it starts and the time zone of that hour. One global row; the compiler
 * reads it at each start (openclaw-config/dreaming.js).
 */
export class DreamingSettings {
  constructor({ dataDir }) {
    this.db = privateDatabase(path.join(dataDir, "assistants"), "dreaming.sqlite");
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, enabled INTEGER NOT NULL, hour INTEGER NOT NULL, time_zone TEXT NOT NULL); INSERT OR IGNORE INTO settings VALUES (1,1,0,3,'UTC');",
    );
  }
  get() {
    const row = this.db.prepare("SELECT * FROM settings WHERE id=1").get();
    return {
      revision: row.revision,
      enabled: !!row.enabled,
      hour: row.hour,
      timeZone: row.time_zone,
    };
  }
  /** The compiler's view: the setting without its revision. */
  compiled() {
    const { enabled, hour, timeZone } = this.get();
    return { enabled, hour, timeZone };
  }
  /** Refuses an invalid setting (400) or a stale revision (409) without saving. */
  check(input, revision) {
    const { enabled, hour, timeZone } = input || {};
    if (
      typeof enabled !== "boolean" ||
      !Number.isInteger(hour) ||
      hour < 0 ||
      hour > 23 ||
      !validTimeZone(timeZone) ||
      !Number.isInteger(revision)
    )
      throw assistantProblem("invalid");
    if (revision !== this.get().revision) throw assistantProblem("conflict", 409);
    return { enabled, hour, timeZone };
  }
  save(input, revision) {
    const { enabled, hour, timeZone } = this.check(input, revision);
    const changed = this.db
      .prepare(
        "UPDATE settings SET revision=revision+1,enabled=?,hour=?,time_zone=? WHERE id=1 AND revision=?",
      )
      .run(enabled ? 1 : 0, hour, timeZone, revision);
    if (!changed.changes) throw assistantProblem("conflict", 409);
    return this.get();
  }
  close() {
    this.db.close();
  }
}
