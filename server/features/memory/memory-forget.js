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
function migrationBackups(root) {
  return fs
    .readdirSync(root)
    .filter((name) => name.startsWith("memory.sqlite."))
    .map((name) => path.join(root, name))
    .filter((file) => fs.lstatSync(file).isFile());
}

/**
 * Overwrites freed pages and the write-ahead log, so the forgotten text leaves the
 * database files. A later full-text index purges its rows in `forgetEntry` before
 * this runs. A reader holding the log open can keep a truncation from finishing.
 */
function purgeStorage(db) {
  db.exec("VACUUM");
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
}

/**
 * Permanently forgets one entry on the owner's request: every revision, the entry row
 * and the write receipts that point at it go in one transaction, which records a
 * content-free tombstone per distinct revision text. Migration backups are removed
 * only with `removeBackups: true`; operations backup archives are never touched.
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
    return rows.length;
  });
  purgeStorage(db);
  let removedBackups = 0;
  if (removeBackups)
    for (const file of migrationBackups(memory.root)) {
      fs.rmSync(file);
      removedBackups += 1;
    }
  return { id, projectId, revisions, removedBackups };
}
