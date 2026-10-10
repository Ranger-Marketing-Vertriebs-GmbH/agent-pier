import { randomUUID, createHash } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
export class ReminderBindings {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_reminder_bindings (id TEXT PRIMARY KEY, assistant_id TEXT NOT NULL REFERENCES assistants(id), operation_key TEXT NOT NULL, body TEXT NOT NULL, UNIQUE(assistant_id,operation_key))",
    );
  }
  list(assistantId) {
    return this.db
      .prepare(
        "SELECT body FROM assistant_reminder_bindings WHERE assistant_id=? ORDER BY rowid",
      )
      .all(assistantId)
      .map((r) => JSON.parse(r.body));
  }
  get(id) {
    const row = this.db
      .prepare("SELECT body FROM assistant_reminder_bindings WHERE id=?")
      .get(id);
    if (!row) throw assistantProblem("notFound", 404);
    return JSON.parse(row.body);
  }
  reserve(assistantId, key, source, input, metadata = {}) {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ source, input }))
      .digest("hex");
    const old = this.list(assistantId).find((r) => r.key === key);
    if (old) {
      if (old.fingerprint !== fingerprint) throw assistantProblem("conflict", 409);
      return { binding: old, fresh: false };
    }
    const binding = {
      ...metadata,
      id: randomUUID(),
      assistantId,
      key,
      source,
      fingerprint,
      nativeId: null,
      state: "prepared",
    };
    this.db
      .prepare("INSERT INTO assistant_reminder_bindings VALUES(?,?,?,?)")
      .run(binding.id, assistantId, key, JSON.stringify(binding));
    return { binding, fresh: true };
  }
  patch(id, patch) {
    const binding = { ...this.get(id), ...patch };
    this.db
      .prepare("UPDATE assistant_reminder_bindings SET body=? WHERE id=?")
      .run(JSON.stringify(binding), id);
    return binding;
  }
}
