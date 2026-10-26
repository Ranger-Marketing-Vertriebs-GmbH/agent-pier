import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

/**
 * OpenClaw (2026.10.3 and 2026.10.7) keeps a copy of every deleted or reset transcript
 * in the agent's database (`session_transcript_archives` in
 * `agents/<id>/agent/openclaw-agent.sqlite`) and publishes it as a file in the agent's
 * sessions folder. Its own retention removes them only under its disk budget or an
 * age rule, never for one session, and no Gateway method or CLI command does
 * (AGENTPIER-220). AgentPier removes both for a deleted chat itself: the rows of
 * exactly that session key or session id, in one short immediate write transaction
 * beside the running Gateway, and the files they name. The same transaction removes
 * the session's Goal receipts (`session_goal_operations`), which quote a Goal's text.
 *
 * The connection never creates a database (`mode=rw`), leaves checkpoints to OpenClaw
 * (`wal_autocheckpoint = 0`), waits briefly for a lock (a busy Gateway fails the purge,
 * and the chat's pending delete retries it) and deletes with `secure_delete`.
 */

const archiveTable = "session_transcript_archives";
const goalTable = "session_goal_operations";
const archiveColumns = ["archive_name", "session_id", "session_key"];
const goalColumns = ["session_id", "session_key"];
// OpenClaw's archive names: `<session id>.jsonl.<deleted|reset>.<timestamp>…`.
const archiveName = /^[^/\\]+\.jsonl\.(deleted|reset)\.[^/\\]+$/;
const failure = (code) => Object.assign(Error(code), { code });

function agentDatabase(stateDir, runtimeAgentId) {
  const file = path.join(
    stateDir,
    "agents",
    runtimeAgentId,
    "agent",
    "openclaw-agent.sqlite",
  );
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw failure("ARCHIVE_DB_UNSAFE");
  return file;
}

function open(file, readOnly, busyMs) {
  const url = pathToFileURL(file);
  url.searchParams.set("mode", readOnly ? "ro" : "rw");
  const db = new DatabaseSync(url, { readOnly });
  db.exec(`PRAGMA busy_timeout = ${Number(busyMs)}`);
  db.exec("PRAGMA wal_autocheckpoint = 0");
  return db;
}

// Whether `table` exists with `columns`; ARCHIVE_SCHEMA when it has other ones.
function hasTable(db, table, columns, required) {
  const names = new Set(
    db
      .prepare("SELECT name FROM pragma_table_info(?)")
      .all(table)
      .map((c) => c.name),
  );
  if (!names.size && !required) return false;
  if (!columns.every((c) => names.has(c))) throw failure("ARCHIVE_SCHEMA");
  return true;
}

// The archive names of one session; with `remove`, read and deleted (archives and Goal
// receipts) in one transaction.
function sessionRows(file, { sessionKey, sessionId, busyMs }, remove) {
  const db = open(file, !remove, busyMs);
  try {
    // The agent's database always holds the table once OpenClaw archived a transcript;
    // a database without it is not the one this was written for.
    hasTable(db, archiveTable, archiveColumns, true);
    const where = "WHERE session_key = ? OR session_id = ?";
    const ids = [sessionKey, sessionId || sessionKey];
    const names = () =>
      db
        .prepare(`SELECT archive_name FROM ${archiveTable} ${where}`)
        .all(...ids)
        .map((row) => row.archive_name);
    if (!remove) return names();
    db.exec("PRAGMA secure_delete = ON");
    db.exec("BEGIN IMMEDIATE");
    try {
      const found = names();
      db.prepare(`DELETE FROM ${archiveTable} ${where}`).run(...ids);
      if (hasTable(db, goalTable, goalColumns, false))
        db.prepare(`DELETE FROM ${goalTable} ${where}`).run(...ids);
      db.exec("COMMIT");
      return found;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  } finally {
    db.close();
  }
}

/**
 * The session ids OpenClaw archived under `sessionKey` (a reset keeps the key and
 * starts a new id; a deleted session's id stays only here), read before the purge
 * removes them. Sorted; none without a database or archive table.
 */
export function archivedSessionIds(stateDir, runtimeAgentId, sessionKey, busyMs = 250) {
  if (typeof sessionKey !== "string" || !sessionKey) return [];
  const file = agentDatabase(stateDir, runtimeAgentId);
  if (!file) return [];
  const db = open(file, true, busyMs);
  try {
    if (!hasTable(db, archiveTable, archiveColumns, false)) return [];
    return db
      .prepare(
        `SELECT DISTINCT session_id FROM ${archiveTable} WHERE session_key = ? ORDER BY 1`,
      )
      .all(sessionKey)
      .map((row) => row.session_id)
      .filter((id) => typeof id === "string" && id);
  } finally {
    db.close();
  }
}

const files = (folder, names) =>
  names.filter((name) => archiveName.test(name)).map((name) => path.join(folder, name));

/**
 * Removes what OpenClaw keeps of one deleted session beside its transcript: the
 * archive rows and Goal receipts in the agent's database and the archive files in its
 * sessions folder. The files go first, while the rows still name them, so a failed
 * attempt is retried in full; once the rows are gone, a file published meanwhile goes
 * too. Throws (with a code, never content) when anything stays; an agent without a
 * database has nothing to remove.
 */
export function purgeTranscriptArchives(
  stateDir,
  runtimeAgentId,
  { sessionKey, sessionId = null, busyMs = 250 },
) {
  if (typeof sessionKey !== "string" || !sessionKey) throw failure("ARCHIVE_KEY");
  const file = agentDatabase(stateDir, runtimeAgentId);
  if (!file) return;
  const session = { sessionKey, sessionId, busyMs };
  const folder = path.join(stateDir, "agents", runtimeAgentId, "sessions");
  for (const archive of files(folder, sessionRows(file, session, false)))
    fs.rmSync(archive, { force: true });
  const removed = files(folder, sessionRows(file, session, true));
  for (const archive of removed) fs.rmSync(archive, { force: true });
  if (sessionRows(file, session, false).length || removed.some((f) => fs.existsSync(f)))
    throw failure("ARCHIVE_REMAINS");
}
