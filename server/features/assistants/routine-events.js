export class RoutineEvents {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_routine_events (binding_id TEXT NOT NULL, event_id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(binding_id,event_id))",
    );
  }
  latest(bindingId) {
    const row = this.db
      .prepare(
        "SELECT body FROM assistant_routine_events WHERE binding_id=? ORDER BY rowid DESC LIMIT 1",
      )
      .get(bindingId);
    return row ? JSON.parse(row.body) : null;
  }
  get(bindingId, eventId) {
    const row = this.db
      .prepare(
        "SELECT body FROM assistant_routine_events WHERE binding_id=? AND event_id=?",
      )
      .get(bindingId, eventId);
    return row ? JSON.parse(row.body) : null;
  }
  reserve(bindingId, eventId) {
    const receipt = { eventId, status: "unknown" };
    const result = this.db
      .prepare("INSERT OR IGNORE INTO assistant_routine_events VALUES(?,?,?)")
      .run(bindingId, eventId, JSON.stringify(receipt));
    return { receipt: this.get(bindingId, eventId), fresh: result.changes === 1 };
  }
  write(bindingId, receipt) {
    this.db
      .prepare(
        "UPDATE assistant_routine_events SET body=? WHERE binding_id=? AND event_id=?",
      )
      .run(JSON.stringify(receipt), bindingId, receipt.eventId);
    return receipt;
  }
}
