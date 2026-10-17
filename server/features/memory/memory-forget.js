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
 * Overwrites freed pages and empties the write-ahead log, so forgotten text leaves
 * the database files, then removes migration backups if a pending purge asked for it
 * and lets `onForget` (the assistant action redaction) run. A later full-text index
 * purges its rows here too. Every step runs even when an earlier one failed; the
 * `purges` markers stay until all of them succeeded, so the next start or forget
 * retries. VACUUM runs synchronously on the main thread and rewrites the whole
 * database, which is small; requests wait for it.
 */
export function purgeForgotten(memory) {
  const { db } = memory;
  const pending = db.prepare("SELECT entry_id,remove_backups FROM purges").all();
  if (!pending.length) return { purged: true, removedBackups: 0 };
  let purged = true,
    removedBackups = 0;
  const attempt = (step) => {
    try {
      if (step() === false) purged = false;
    } catch {
      purged = false;
    }
  };
  attempt(() => memory.onForget?.());
  attempt(() => db.exec("VACUUM"));
  if (pending.some((row) => row.remove_backups))
    for (const file of migrationBackups(memory.root))
      attempt(() => {
        fs.rmSync(file);
        removedBackups += 1;
      });
  const checkpoint = () => {
    const { busy, log } = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    return busy === 0 && log === 0;
  };
  attempt(checkpoint);
  if (purged) {
    // Clearing the markers writes no content; truncate the log once more after it.
    const clear = db.prepare("DELETE FROM purges WHERE entry_id=?");
    for (const row of pending) clear.run(row.entry_id);
    attempt(checkpoint);
  }
  return { purged, removedBackups };
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
    db.prepare("INSERT OR REPLACE INTO purges VALUES (?,?,?)").run(
      id,
      Number(removeBackups),
      now,
    );
    return rows.length;
  });
  const { purged, removedBackups } = purgeForgotten(memory);
  return {
    id,
    projectId,
    revisions,
    removedBackups,
    purged,
    ...(purged ? {} : { notice: serverMessages.memory.purgePending }),
  };
}
