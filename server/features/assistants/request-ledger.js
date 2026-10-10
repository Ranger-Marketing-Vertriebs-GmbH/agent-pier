import { randomUUID } from "node:crypto";
import { assistantProblem, textValue } from "./assistant-validation.js";
const terminal = new Set(["completed", "failed", "cancelled"]);
const states = new Set([
  "pending",
  "accepted",
  "running",
  ...terminal,
  "interrupted",
  "uncertain",
]);
const requestRecord = (r) =>
  r && {
    id: r.id,
    conversationId: r.conversation_id,
    clientRequestId: r.client_key,
    text: r.text,
    state: r.state,
    createdAt: r.created_at,
  };
const attemptQuery =
  "SELECT attempts.*, (SELECT reviewed_at FROM attempt_reviews WHERE attempt_id=attempts.id) AS reviewed_at FROM attempts";
const attemptRecord = (r) =>
  r && {
    id: r.id,
    requestId: r.request_id,
    runtimeRunId: r.runtime_run_id,
    reviewedAt: r.reviewed_at || null,
    state: r.state,
    createdAt: r.created_at,
  };
export class RequestLedger {
  constructor(db) {
    this.db = db;
  }
  accept(conversationId, { clientRequestId, text }) {
    textValue(clientRequestId, 100);
    textValue(text);
    const existing = this.db
      .prepare("SELECT * FROM requests WHERE conversation_id=? AND client_key=?")
      .get(conversationId, clientRequestId);
    if (existing) {
      if (existing.text !== text) throw assistantProblem("conflict", 409);
      return requestRecord(existing);
    }
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO requests VALUES (?,?,?,?,?,?)")
      .run(
        id,
        conversationId,
        clientRequestId,
        text,
        "pending",
        new Date().toISOString(),
      );
    return this.getRequest(id);
  }
  getRequest(id) {
    const r = requestRecord(this.db.prepare("SELECT * FROM requests WHERE id=?").get(id));
    if (!r) throw assistantProblem("notFound", 404);
    return r;
  }
  requests(conversationId) {
    return this.db
      .prepare("SELECT * FROM requests WHERE conversation_id=? ORDER BY rowid")
      .all(conversationId)
      .map(requestRecord);
  }
  recordAttempt(requestId, { runtimeRunId = null } = {}) {
    this.getRequest(requestId);
    const existing = this.attemptFor(requestId);
    if (existing) return existing;
    const id = randomUUID();
    this.db
      .prepare("INSERT INTO attempts VALUES (?,?,?,?,?,?)")
      .run(id, requestId, runtimeRunId, "pending", "{}", new Date().toISOString());
    return this.getAttempt(id);
  }
  attemptFor(requestId) {
    return attemptRecord(
      this.db
        .prepare(`${attemptQuery} WHERE request_id=? ORDER BY rowid DESC LIMIT 1`)
        .get(requestId),
    );
  }
  getAttempt(id) {
    const a = attemptRecord(this.db.prepare(`${attemptQuery} WHERE id=?`).get(id));
    if (!a) throw assistantProblem("notFound", 404);
    return a;
  }
  transition(id, state, evidence = {}) {
    if (!states.has(state)) throw assistantProblem("invalid");
    const current = this.getAttempt(id);
    if (terminal.has(current.state)) return current;
    if (current.state === "running" && ["pending", "accepted"].includes(state))
      return current;
    const runtimeRunId = evidence.runtimeRunId || current.runtimeRunId;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare("UPDATE attempts SET state=?,runtime_run_id=?,evidence=? WHERE id=?")
        .run(state, runtimeRunId, JSON.stringify(evidence), id);
      this.db
        .prepare("UPDATE requests SET state=? WHERE id=?")
        .run(state, current.requestId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return this.getAttempt(id);
  }
  review(id) {
    const attempt = this.getAttempt(id);
    if (!["uncertain", "interrupted"].includes(attempt.state))
      throw assistantProblem("active", 409);
    this.db
      .prepare("INSERT OR IGNORE INTO attempt_reviews VALUES (?,?)")
      .run(id, new Date().toISOString());
    return this.getAttempt(id);
  }
  pending() {
    return this.unresolved();
  }
  // A reviewed attempt keeps its unknown outcome permanently; it is never polled
  // again and never blocks new turns.
  unresolved() {
    return this.db
      .prepare(
        `${attemptQuery} WHERE state NOT IN ('completed','failed','cancelled') AND NOT EXISTS (SELECT 1 FROM attempt_reviews WHERE attempt_id=attempts.id) ORDER BY rowid`,
      )
      .all()
      .map(attemptRecord);
  }
}
