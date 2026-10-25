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
const evidenceOf = (r) => {
  try {
    return JSON.parse(r.evidence || "{}") || {};
  } catch {
    return {};
  }
};
// Why a failed turn ended, when AgentPier knows it: its run timed out or stalled, or
// the Gateway refused it before running it (conversation-turns.js sendRefusal).
const failures = new Set(["timeout", "stalled", "degraded", "starting", "refused"]);
// A send whose acknowledgement was lost (conversation-turns.js) leaves the attempt
// uncertain but confirmable: the Gateway may still prove it runs the turn.
const unconfirmedSend = (r) =>
  r.state === "uncertain" && !r.reviewed_at && evidenceOf(r).unconfirmed === "send";
const attemptRecord = (r) =>
  r && {
    id: r.id,
    requestId: r.request_id,
    runtimeRunId: r.runtime_run_id,
    reviewedAt: r.reviewed_at || null,
    state: r.state,
    createdAt: r.created_at,
    ...(unconfirmedSend(r) ? { unconfirmed: true } : {}),
    // Why a failed turn ended, when AgentPier knows (run-reconciler.js,
    // run-stall-guard.js, conversation-turns.js): one of `failures`.
    ...(r.state === "failed" && failures.has(evidenceOf(r).failure)
      ? { failure: evidenceOf(r).failure }
      : {}),
  };
export class RequestLedger {
  constructor(db) {
    this.db = db;
  }
  accept(conversationId, { clientRequestId, text, attachments }) {
    textValue(clientRequestId, 100);
    // A message may be only files; the agent then receives just their saved paths.
    textValue(text, 65536, Array.isArray(attachments) && attachments.length > 0);
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
  /** Blanks a deleted user's message texts; the rows stay for their attempts. */
  forgetTexts(conversationId) {
    this.db
      .prepare("UPDATE requests SET text='' WHERE conversation_id=?")
      .run(conversationId);
  }
  requests(conversationId) {
    return this.db
      .prepare("SELECT * FROM requests WHERE conversation_id=? ORDER BY rowid")
      .all(conversationId)
      .map(requestRecord);
  }
  /** The conversation's requests created at or after `since` (an ISO time). */
  requestsSince(conversationId, since) {
    return this.db
      .prepare(
        "SELECT * FROM requests WHERE conversation_id=? AND created_at>=? ORDER BY rowid",
      )
      .all(conversationId, since)
      .map(requestRecord);
  }
  /** The conversation's newest request, or null, without reading the others. */
  latestRequest(conversationId) {
    return (
      requestRecord(
        this.db
          .prepare(
            "SELECT * FROM requests WHERE conversation_id=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(conversationId),
      ) || null
    );
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
  // The attempt a Gateway run belongs to: its idempotency key is the attempt id, and
  // the Gateway may report its own run id instead.
  attemptForRun(runId) {
    if (typeof runId !== "string" || !runId) return null;
    return attemptRecord(
      this.db
        .prepare(
          `${attemptQuery} WHERE id=? OR runtime_run_id=? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(runId, runId),
    );
  }
  // Every delivery key of a conversation's attempts (the attempt id, which is the
  // idempotency key sent to the Gateway, and the Gateway's own run id) to its request.
  // One statement per history read (message-source.js).
  attemptRequests(conversationId) {
    const keys = new Map();
    for (const row of this.db
      .prepare(
        "SELECT a.id, a.runtime_run_id, a.request_id FROM attempts a JOIN requests r ON r.id=a.request_id WHERE r.conversation_id=?",
      )
      .all(conversationId)) {
      keys.set(row.id, row.request_id);
      if (row.runtime_run_id) keys.set(row.runtime_run_id, row.request_id);
    }
    return keys;
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
  /**
   * Moves an unreviewed uncertain attempt whose send went unacknowledged to running,
   * once the Gateway proved it runs the turn (`proof`: "event" or "transcript").
   * Only on the Gateway generation the send went to: a restart ended that run. Every
   * other attempt is left as it is; returns the confirmed attempt or null.
   */
  confirm(id, { generation = null, proof } = {}) {
    const row = this.db.prepare(`${attemptQuery} WHERE id=?`).get(id);
    if (!row || !unconfirmedSend(row)) return null;
    if ((evidenceOf(row).generation ?? null) !== generation) return null;
    return this.transition(id, "running", {
      runtimeRunId: row.runtime_run_id || id,
      confirmedBy: proof,
    });
  }
  /**
   * After an AgentPier restart no unconfirmed send can be proven any more: the
   * Gateway it went to belongs to the previous process. They stay plain uncertain.
   */
  forgetUnconfirmed() {
    for (const row of this.db
      .prepare(`${attemptQuery} WHERE state='uncertain'`)
      .all()
      .filter(unconfirmedSend))
      this.db.prepare("UPDATE attempts SET evidence='{}' WHERE id=?").run(row.id);
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
  // One row per conversation: its latest request and that request's latest attempt.
  // The list endpoint derives agent activity from this on every refresh, so it stays a
  // single statement over the existing indexes.
  latestByConversation() {
    return this.db
      .prepare(
        `SELECT r.conversation_id, r.id AS request_id, r.state AS request_state,
          a.id AS attempt_id, a.state AS attempt_state, a.evidence AS attempt_evidence,
          (SELECT reviewed_at FROM attempt_reviews WHERE attempt_id=a.id) AS reviewed_at
        FROM requests r
        LEFT JOIN attempts a
          ON a.rowid=(SELECT MAX(rowid) FROM attempts WHERE request_id=r.id)
        WHERE r.rowid=(SELECT MAX(rowid) FROM requests WHERE conversation_id=r.conversation_id)
        ORDER BY r.rowid`,
      )
      .all()
      .map((r) => ({
        conversationId: r.conversation_id,
        requestId: r.request_id,
        requestState: r.request_state,
        attemptId: r.attempt_id ?? null,
        // A turn awaiting the Gateway's confirmation is working, not an unclear outcome.
        attemptState: unconfirmedSend({
          state: r.attempt_state,
          reviewed_at: r.reviewed_at,
          evidence: r.attempt_evidence,
        })
          ? "unconfirmed"
          : (r.attempt_state ?? null),
        reviewedAt: r.reviewed_at ?? null,
      }));
  }
}
