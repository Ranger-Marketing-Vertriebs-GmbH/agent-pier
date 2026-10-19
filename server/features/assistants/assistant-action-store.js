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
/** The patch that removes a memory write's title and content. */
export function memoryRedaction(payload) {
  return {
    payload: { ...payload, title: "", content: "" },
    diagnostic: "MEMORY_FORGOTTEN",
  };
}
export class AssistantActionStore {
  constructor(db) {
    this.db = db;
    // Counts writes; `onWrite(...rows)` hears every written row (AssistantWorkflows
    // re-reads the chat feeds of the agents these rows belong to).
    this.writes = 0;
    this.onWrite = null;
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
  // on the parent agent with a teamId. A member's shell request in a turn its lead
  // delegated (leadAssistantId) waits in both chats, so it counts for both. Expiry is
  // applied lazily elsewhere, so it is checked here as well.
  awaitingCounts(now = Date.now()) {
    const counts = {};
    const rows = this.db
      .prepare(
        "SELECT assistant_id, json_extract(body,'$.teamId') AS team_id, json_extract(body,'$.leadAssistantId') AS lead_id, json_extract(body,'$.expiresAt') AS expires_at FROM assistant_actions WHERE json_extract(body,'$.state')='awaiting_approval'",
      )
      .all();
    const count = (id) => (counts[id] ??= { own: 0, team: 0 });
    for (const r of rows) {
      if (r.expires_at != null && r.expires_at <= now) continue;
      if (r.team_id) count(r.assistant_id).team++;
      else count(r.assistant_id).own++;
      if (r.lead_id) count(r.lead_id).team++;
    }
    return counts;
  }
  // Every approval the owner still has to decide, oldest first, for the owner's inbox;
  // expired ones are left out as in awaitingCounts.
  awaiting(now = Date.now()) {
    return this.db
      .prepare(
        "SELECT body FROM assistant_actions WHERE json_extract(body,'$.state')='awaiting_approval' AND (json_extract(body,'$.expiresAt') IS NULL OR json_extract(body,'$.expiresAt')>?) ORDER BY rowid",
      )
      .all(now)
      .map((r) => JSON.parse(r.body));
  }
  // Members' requests still waiting in turns this lead delegated, and their allowed SSH
  // commands while they run, as the member's own chat shows them.
  delegated(leadId) {
    return this.db
      .prepare(
        "SELECT body FROM assistant_actions WHERE json_extract(body,'$.leadAssistantId')=? AND (json_extract(body,'$.state')='awaiting_approval' OR (json_extract(body,'$.state')='executing' AND json_extract(body,'$.payload.action')='ssh')) ORDER BY rowid",
      )
      .all(leadId)
      .map((r) => JSON.parse(r.body));
  }
  // Coding and memory requests for a project that are not started yet: the actions
  // whose authority is the project grant. SSH and exec cards name a project too, but
  // their SSH grant or the Gateway decides them.
  unstarted(projectId) {
    return this.db
      .prepare(
        "SELECT body FROM assistant_actions WHERE json_extract(body,'$.payload.projectId')=? AND json_extract(body,'$.payload.action') IN ('coding_start','memory_write') AND json_extract(body,'$.state') IN ('awaiting_approval','approved') ORDER BY rowid",
      )
      .all(projectId)
      .map((r) => JSON.parse(r.body));
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
    this.written(a);
    return a;
  }
  patch(id, values) {
    const a = this.get(id),
      next = { ...a, ...values, revision: a.revision + 1 };
    this.db
      .prepare("UPDATE assistant_actions SET body=? WHERE id=?")
      .run(JSON.stringify(next), id);
    this.written(a, next);
    return next;
  }
  written(...rows) {
    this.writes++;
    this.onWrite?.(...rows);
  }
  /**
   * Clears title and content of agent memory writes that stored an entry an owner
   * forgot (memory-forget.js), with secure_delete so the old text is overwritten. A
   * write still waiting for approval is cancelled. Returns the IDs of every memory
   * write that held forgotten text, already redacted ones included, so their channel
   * notices can be redacted as well.
   */
  redactMemoryWrites(entryIds) {
    const forgotten = new Set(entryIds);
    const held = this.db
      .prepare(
        "SELECT body FROM assistant_actions WHERE json_extract(body,'$.payload.action')='memory_write'",
      )
      .all()
      .map((r) => JSON.parse(r.body))
      .filter(
        (a) =>
          a.diagnostic === "MEMORY_FORGOTTEN" ||
          forgotten.has(a.result?.id) ||
          forgotten.has(a.payload.id),
      );
    const rows = held.filter((a) => a.diagnostic !== "MEMORY_FORGOTTEN");
    const ids = held.map((a) => a.id);
    if (!rows.length) return ids;
    const previous = this.db.prepare("PRAGMA secure_delete").get().secure_delete;
    this.db.exec("PRAGMA secure_delete=ON");
    try {
      for (const a of rows)
        this.patch(a.id, {
          ...memoryRedaction(a.payload),
          ...(["awaiting_approval", "approved"].includes(a.state)
            ? { state: "cancelled" }
            : {}),
        });
      this.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } finally {
      this.db.exec(`PRAGMA secure_delete=${previous ? "ON" : "OFF"}`);
    }
    return ids;
  }
  // Trusted SSH runs keep only their newest rows per agent; the audit keeps the rest.
  pruneTrustedSsh(assistantId, keep) {
    const trusted =
      "assistant_id=? AND json_extract(body,'$.payload.action')='ssh' AND json_extract(body,'$.payload.trusted')=1";
    const { changes } = this.db
      .prepare(
        `DELETE FROM assistant_actions WHERE ${trusted} AND rowid NOT IN (SELECT rowid FROM assistant_actions WHERE ${trusted} ORDER BY rowid DESC LIMIT ?)`,
      )
      .run(assistantId, assistantId, keep);
    if (changes) this.written({ assistantId });
  }
}
