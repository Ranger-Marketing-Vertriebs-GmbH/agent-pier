import { redactSecrets } from "../../lib/secret-redaction.js";
import { commandDigest, redactedCommand } from "./agent-ssh-text.js";

/**
 * One-time redaction of SSH commands stored before redaction existed
 * (docs/assistant-gateway.md#agent-ssh-access-2026-10-16): every SSH row that can no
 * longer run gets the original's digest (so a retry of the same call still finds its
 * card) and its command and preview with recognisable secrets replaced, and the
 * Telegram texts about those rows are rewritten the same way. Rows awaiting approval,
 * approved or executing keep the exact command until they settle, as new rows do.
 *
 * The plaintext must not stay in the database files: the rewrite runs with
 * secure_delete, VACUUM then rewrites every page (earlier revisions of a row survive
 * in freed space otherwise) and a TRUNCATE checkpoint empties the write-ahead log.
 * The marker in `assistant_migrations` is set only once all of this succeeded, so a
 * failure retries at the next start; a rerun changes nothing that is redacted already.
 */
export const sshBackfillMarker = "ssh-command-redaction";
const running = new Set(["awaiting_approval", "approved", "executing"]);
const chunk = 500;

/** Runs the backfill unless its marker is set; returns whether it ran. */
export function backfillSshCommands({ store, s }) {
  const { db } = store;
  db.exec(
    "CREATE TABLE IF NOT EXISTS assistant_migrations(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  if (
    db.prepare("SELECT 1 FROM assistant_migrations WHERE name=?").get(sshBackfillMarker)
  )
    return false;
  try {
    const ids = redactRows(store);
    const outbox = s.assistantChannels?.outbox;
    let clean = scrub(db);
    if (outbox) {
      for (let i = 0; i < ids.length; i += chunk)
        outbox.rewriteActions(ids.slice(i, i + chunk), redactSecrets);
      clean = scrub(outbox.db) && clean;
    }
    if (!clean) return true;
    db.prepare("INSERT OR IGNORE INTO assistant_migrations VALUES(?,?)").run(
      sshBackfillMarker,
      new Date().toISOString(),
    );
    db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
  } catch (error) {
    // Only the error's code or name: its message could quote a command.
    console.error(
      `AgentPier could not redact SSH commands stored before redaction existed; it retries at the next start: ${error?.code || error?.name || "unknown error"}`,
    );
  }
  return true;
}

/** The payload of a settled SSH row with secrets redacted, or null when unchanged. */
export function redactedSshPayload(payload) {
  const next = { ...payload };
  if (typeof payload.command === "string") {
    next.commandSha256 = payload.commandSha256 ?? commandDigest(payload.command);
    Object.assign(next, redactedCommand(payload));
  }
  if (typeof payload.commandPreview === "string") {
    next.commandPreview = redactSecrets(payload.commandPreview);
    if (next.commandPreview !== payload.commandPreview) next.commandRedacted = true;
  }
  return JSON.stringify(next) === JSON.stringify(payload) ? null : next;
}

// Rewrites the rows in one transaction with secure_delete; returns the IDs of every
// approval row that can no longer run, for its Telegram texts.
function redactRows(store) {
  const rows = store.db
    .prepare(
      "SELECT body FROM assistant_actions WHERE json_extract(body,'$.payload.action')='ssh' ORDER BY rowid",
    )
    .all()
    .map((r) => JSON.parse(r.body))
    .filter((a) => !running.has(a.state));
  const previous = store.db.prepare("PRAGMA secure_delete").get().secure_delete;
  store.db.exec("PRAGMA secure_delete=ON");
  try {
    store.db.exec("BEGIN IMMEDIATE");
    try {
      for (const a of rows) {
        const payload = redactedSshPayload(a.payload);
        if (payload) store.patch(a.id, { payload });
      }
      store.db.exec("COMMIT");
    } catch (error) {
      store.db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    store.db.exec(`PRAGMA secure_delete=${previous ? "ON" : "OFF"}`);
  }
  return rows.filter((a) => !a.payload.trusted).map((a) => a.id);
}

// VACUUM leaves no freed page or cell with old text; the checkpoint empties the log.
function scrub(db) {
  try {
    db.exec("VACUUM");
    const { busy, log } = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return busy === 0 && log === 0;
  } catch {
    return false;
  }
}
