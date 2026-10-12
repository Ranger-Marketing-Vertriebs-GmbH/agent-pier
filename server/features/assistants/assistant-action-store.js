import { randomUUID } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { digest } from "./assistant-access.js";
export const actionTerminal = new Set([
  "completed",
  "failed",
  "cancelled",
  "declined",
  "expired",
  "reviewed",
]);
export class AssistantActionStore {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS assistant_actions(id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL REFERENCES assistants(id),operation_key TEXT UNIQUE NOT NULL,body TEXT NOT NULL)",
    );
    for (const a of this.list())
      if (a.state === "executing") this.patch(a.id, { state: "unknown" });
  }
  list(id) {
    return this.db
      .prepare(
        `SELECT body FROM assistant_actions${id ? " WHERE assistant_id=?" : ""} ORDER BY rowid`,
      )
      .all(...(id ? [id] : []))
      .map((r) => JSON.parse(r.body));
  }
  // Actions that still need work: non-terminal ones, and terminal ones whose
  // notifications or follow-up events are not settled yet.
  open() {
    return this.db
      .prepare(
        "SELECT body FROM assistant_actions WHERE json_extract(body,'$.settled') IS NOT 1 ORDER BY rowid",
      )
      .all()
      .map((r) => JSON.parse(r.body));
  }
  // Approvals the owner still has to decide, per agent. Team coding requests are stored
  // on the parent agent with a teamId. Expiry is applied lazily elsewhere, so it is
  // checked here as well.
  awaitingCounts(now = Date.now()) {
    const counts = {};
    const rows = this.db
      .prepare(
        "SELECT assistant_id, json_extract(body,'$.teamId') AS team_id, json_extract(body,'$.expiresAt') AS expires_at FROM assistant_actions WHERE json_extract(body,'$.state')='awaiting_approval'",
      )
      .all();
    for (const r of rows) {
      if (r.expires_at != null && r.expires_at <= now) continue;
      const count = (counts[r.assistant_id] ??= { own: 0, team: 0 });
      if (r.team_id) count.team++;
      else count.own++;
    }
    return counts;
  }
  get(id) {
    const r = this.db.prepare("SELECT body FROM assistant_actions WHERE id=?").get(id);
    if (!r) throw assistantProblem("notFound", 404);
    return JSON.parse(r.body);
  }
  // The action reserved under an operation key, or null.
  byKey(key) {
    const r = this.db
      .prepare("SELECT body FROM assistant_actions WHERE operation_key=?")
      .get(String(key));
    return r ? JSON.parse(r.body) : null;
  }
  reserve(record) {
    const hash = digest({
      assistantId: record.assistantId,
      payload: record.payload,
      origin: record.origin,
    });
    const old = this.db
      .prepare("SELECT body FROM assistant_actions WHERE operation_key=?")
      .get(record.key);
    if (old) {
      const a = JSON.parse(old.body);
      if (a.hash !== hash) throw assistantProblem("conflict", 409);
      return a;
    }
    const a = {
      ...record,
      hash,
      id: randomUUID(),
      revision: 1,
      createdAt: new Date().toISOString(),
      // An exec approval carries the Gateway's own expiry.
      expiresAt: record.expiresAt ?? Date.now() + 86400000,
    };
    this.db
      .prepare("INSERT INTO assistant_actions VALUES(?,?,?,?)")
      .run(a.id, a.assistantId, a.key, JSON.stringify(a));
    return a;
  }
  patch(id, values) {
    const a = this.get(id),
      next = { ...a, ...values, revision: a.revision + 1 };
    this.db
      .prepare("UPDATE assistant_actions SET body=? WHERE id=?")
      .run(JSON.stringify(next), id);
    return next;
  }
}
