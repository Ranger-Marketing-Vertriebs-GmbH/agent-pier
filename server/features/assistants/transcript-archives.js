import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * OpenClaw 2026.10.7 keeps a copy of every deleted or reset transcript in the agent's
 * database (`session_transcript_archives` in `agents/<id>/agent/openclaw-agent.sqlite`)
 * and publishes it as a file in the agent's sessions folder. Its own retention removes
 * them only under its disk budget or an age rule, never for one session, and no Gateway
 * method or CLI command does (AGENTPIER-220). AgentPier removes both for a deleted chat
 * itself: the rows of exactly that session key or session id, in one short immediate
 * write transaction beside the running Gateway (WAL, busy timeout as OpenClaw's own,
 * `secure_delete` so the freed pages are overwritten), and the files they name.
 */

const archiveTable = "session_transcript_archives";
// OpenClaw's archive names: `<session id>.jsonl.<deleted|reset>.<timestamp>…`.
const archiveName = /^[^/\\]+\.jsonl\.(deleted|reset)\.[^/\\]+$/;

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
  if (!stat.isFile() || stat.isSymbolicLink())
    throw Object.assign(Error("Unsafe agent database."), { code: "ARCHIVE_DB_UNSAFE" });
  return file;
}

// The archive names of one session; with `remove`, read and deleted in one transaction.
function archiveRows(file, { sessionKey, sessionId, busyMs }, remove) {
  const db = new DatabaseSync(file);
  try {
    db.exec(`PRAGMA busy_timeout = ${Number(busyMs)}`);
    const table = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?")
      .get(archiveTable);
    if (!table) return [];
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

const files = (folder, names) =>
  names.filter((name) => archiveName.test(name)).map((name) => path.join(folder, name));

/**
 * Removes the transcript archives OpenClaw keeps of one deleted session: its rows in the
 * agent's database and the files they name in its sessions folder. The files go first,
 * while the rows still name them, so a failed attempt is retried in full; once the rows
 * are gone, a file published meanwhile goes too. Throws when anything stays.
 */
export function purgeTranscriptArchives(
  stateDir,
  runtimeAgentId,
  { sessionKey, sessionId = null, busyMs = 5000 },
) {
  if (typeof sessionKey !== "string" || !sessionKey) throw Error("Missing session key.");
  const file = agentDatabase(stateDir, runtimeAgentId);
  if (!file) return;
  const session = { sessionKey, sessionId, busyMs };
  const folder = path.join(stateDir, "agents", runtimeAgentId, "sessions");
  for (const archive of files(folder, archiveRows(file, session, false)))
    fs.rmSync(archive, { force: true });
  const removed = files(folder, archiveRows(file, session, true));
  for (const archive of removed) fs.rmSync(archive, { force: true });
  if (archiveRows(file, session, false).length || removed.some((f) => fs.existsSync(f)))
    throw Object.assign(Error("Transcript archive remains."), {
      code: "ARCHIVE_REMAINS",
    });
}
