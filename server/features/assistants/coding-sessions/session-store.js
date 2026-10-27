import { assistantProblem } from "../assistant-validation.js";

/**
 * Which agent started which coding session: one record per session, written when
 * the agent starts it and kept after it ends (the agent's list and the owner's
 * views read it). Record:
 * `{ sessionId, assistantId, conversationId, projectId, actionId, requestId,
 *    origin: { class, bindingId?, hookId? }, inherited: { leadId, shareId } | null,
 *    worktree: { runId, cwd, branch, baseBranch, removed? } | null,
 *    seen: { state, at }, observed: { state, since } | null,
 *    lastSentAt: number | null, wakeSeq: number, ended: boolean, createdAt,
 *    pending?: true }`. A record is written `pending` before the launch, so a
 * startup prompt of the session is already held for the agent; the start clears it
 * once the session runs and deletes the record when the launch fails.
 */
export class AgentSessionStore {
  constructor(db) {
    this.db = db;
    db.exec(
      "CREATE TABLE IF NOT EXISTS agent_coding_sessions(session_id TEXT PRIMARY KEY,assistant_id TEXT NOT NULL,body TEXT NOT NULL)",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS agent_coding_sessions_assistant ON agent_coding_sessions(assistant_id)",
    );
  }
  insert(record) {
    if (!record?.sessionId || !record.assistantId) throw assistantProblem("invalid");
    this.db
      .prepare(
        "INSERT INTO agent_coding_sessions(session_id,assistant_id,body) VALUES(?,?,?)",
      )
      .run(record.sessionId, record.assistantId, JSON.stringify(record));
    return this.get(record.sessionId);
  }
  get(sessionId) {
    if (typeof sessionId !== "string") return null;
    const row = this.db
      .prepare("SELECT body FROM agent_coding_sessions WHERE session_id=?")
      .get(sessionId);
    return row ? JSON.parse(row.body) : null;
  }
  forAgent(assistantId) {
    return this.db
      .prepare(
        "SELECT body FROM agent_coding_sessions WHERE assistant_id=? ORDER BY rowid",
      )
      .all(assistantId)
      .map((row) => JSON.parse(row.body));
  }
  all() {
    return this.db
      .prepare("SELECT body FROM agent_coding_sessions ORDER BY rowid")
      .all()
      .map((row) => JSON.parse(row.body));
  }
  delete(sessionId) {
    this.db
      .prepare("DELETE FROM agent_coding_sessions WHERE session_id=?")
      .run(sessionId);
  }
  /** Merges `values` into the record; the session and its agent never change. */
  patch(sessionId, values) {
    const current = this.get(sessionId);
    if (!current) throw assistantProblem("notFound", 404);
    const next = {
      ...current,
      ...values,
      sessionId: current.sessionId,
      assistantId: current.assistantId,
    };
    this.db
      .prepare("UPDATE agent_coding_sessions SET body=? WHERE session_id=?")
      .run(JSON.stringify(next), sessionId);
    return next;
  }
}
