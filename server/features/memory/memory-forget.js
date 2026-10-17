import { serverMessages } from "../../lib/i18n/de.js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { transaction } from "./memory-database.js";
import { failure, identifier, textValue } from "./memory-validation.js";

/**
 * The hash a tombstone stores for one revision: its title and content after Unicode
 * normalization, with surrounding whitespace removed and inner whitespace runs
 * collapsed. It blocks the identical text only, never a variant that embeds it.
 */
export function tombstoneHash(title, content) {
  const normal = (text) => text.normalize("NFC").trim().replace(/\s+/gu, " ");
  return createHash("sha256")
    .update(JSON.stringify([normal(title), normal(content)]))
    .digest("hex");
}

/** Rejects a write whose title and content an owner forgot in this project. */
export function refuseForgotten(db, projectId, title, content) {
  const hit = db
    .prepare("SELECT 1 FROM tombstones WHERE project_id=? AND hash=?")
    .get(projectId, tombstoneHash(title, content));
  if (hit) throw failure(serverMessages.memory.forgottenContent, 422);
}

/** Migration backups `memory.sqlite.<label>-<stamp>` next to the database. */
export function migrationBackups(root) {
  return fs
    .readdirSync(root)
    .filter((name) => name.startsWith("memory.sqlite."))
    .map((name) => path.join(root, name))
    .filter((file) => fs.lstatSync(file).isFile());
}

/**
 * Finishes pending forgets. `files`: VACUUM overwrites freed pages and a TRUNCATE
 * checkpoint empties the write-ahead log, so the text leaves the database files (a
 * later full-text index purges its rows here too). `records`: `onForget`, set by the
 * agent services, redacts their copies of forgotten text; without it the marker waits
 * for them to start. Every step runs even when another failed, and each marker flag is
 * cleared only after its step succeeded, so the next start or forget retries.
 * VACUUM runs synchronously on the main thread and rewrites the whole database,
 * which is small; requests wait for it.
 */
export function purgeForgotten(memory) {
  const { db } = memory;
  const pending = db.prepare("SELECT entry_id,files,records FROM purges").all();
  let purged = !pending.some((row) => row.files),
    redacted = !pending.some((row) => row.records);
  if (!purged) {
    const checkpoint = () => {
      const { busy, log } = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
      return busy === 0 && log === 0;
    };
    try {
      db.exec("VACUUM");
      purged = true;
    } catch {
      purged = false;
    }
    try {
      purged = checkpoint() && purged;
    } catch {
      purged = false;
    }
    if (purged) db.exec("UPDATE purges SET files=0");
  }
  if (!redacted && memory.onForget)
    try {
      memory.onForget();
      db.exec("UPDATE purges SET records=0");
      redacted = true;
    } catch (error) {
      // Only the error's code or name: its message could quote the text.
      console.error(
        `AgentPier could not redact agent records of a forgotten memory entry; it retries: ${error?.code || error?.name || "unknown error"}`,
      );
    }
  db.exec("DELETE FROM purges WHERE files=0 AND records=0");
  // Clearing the markers writes no content; empty the log once more after it.
  if (purged)
    try {
      db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    } catch {
      // The text is already gone from the log; only marker updates remain in it.
    }
  return { purged, redacted: redacted || !memory.onForget };
}

/** Deletes the migration backups on the owner's confirmation; best effort. */
function removeMigrationBackups(root) {
  let removed = 0;
  for (const file of migrationBackups(root))
    try {
      fs.rmSync(file);
      removed += 1;
    } catch {
      // Reported through the count; the owner sees the remaining backups.
    }
  return removed;
}

/**
 * Permanently forgets one entry on the owner's request: every revision, the entry row
 * and the write receipts that point at it go in one transaction, which records a
 * content-free tombstone per distinct revision text and a purge marker. The purge
 * itself (purgeForgotten) never fails the request; it reports `purged: false` and is
 * retried. Migration backups are removed only with `removeBackups: true`; operations
 * backup archives are never touched.
 */
export function forgetEntry(
  memory,
  projectId,
  id,
  { expectedRevision, reason = "", removeBackups = false },
  actor,
) {
  identifier(id);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
    throw failure(serverMessages.memory.expectedRevisionRequired);
  if (typeof removeBackups !== "boolean")
    throw failure(serverMessages.memory.invalidInput);
  const why = textValue(reason, serverMessages.memory.invalidForgetReason, 500, {
    empty: true,
  }).trim();
  const { db } = memory;
  const revisions = transaction(db, () => {
    const current = memory.read(projectId, id);
    if (current.revision !== expectedRevision)
      throw failure(serverMessages.memory.changed, 409);
    const rows = db
      .prepare("SELECT title,content FROM revisions WHERE entry_id=?")
      .all(id);
    const now = new Date().toISOString();
    const tombstone = db.prepare("INSERT OR IGNORE INTO tombstones VALUES (?,?,?,?,?,?)");
    for (const row of rows)
      tombstone.run(
        projectId,
        tombstoneHash(row.title, row.content),
        id,
        why,
        actor,
        now,
      );
    db.prepare("DELETE FROM requests WHERE entry_id=?").run(id);
    db.prepare("DELETE FROM revisions WHERE entry_id=?").run(id);
    db.prepare("DELETE FROM entries WHERE id=?").run(id);
    db.prepare("INSERT OR REPLACE INTO purges VALUES (?,1,1,?)").run(id, now);
    return rows.length;
  });
  // Backups made after the transaction cannot hold the text, so only this call
  // removes them; a retried purge never deletes backups.
  const removedBackups = removeBackups ? removeMigrationBackups(memory.root) : 0;
  const { purged, redacted } = purgeForgotten(memory);
  const notices = [
    ...(purged ? [] : [serverMessages.memory.purgePending]),
    ...(redacted ? [] : [serverMessages.memory.recordsPending]),
  ];
  return {
    id,
    projectId,
    revisions,
    removedBackups,
    purged,
    redacted,
    ...(notices.length ? { notice: notices.join(" ") } : {}),
  };
}
