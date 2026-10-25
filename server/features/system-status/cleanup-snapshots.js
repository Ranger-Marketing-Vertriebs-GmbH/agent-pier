import fs from "node:fs";
import path from "node:path";
import { readJSON } from "../../lib/storage.js";
import {
  listBackups,
  removeBackup,
  terminalPhases,
} from "../assistants/runtime-retention.js";
import { measureTree } from "./safe-tree.js";
import { cleanupProblem } from "./cleanup-problem.js";

/*
 * The agents' update backups (assistants/backups/<id>, runtime-update-snapshot.js).
 * With agents turned on, listing and deleting go through RuntimeUpdates, whose
 * exclusive lock keeps an update from starting meanwhile. With agents off no update
 * can run; the journal on disk then decides alone.
 */
function filePaths(dataDir) {
  return { root: path.join(dataDir, "assistants") };
}
function storedJournal(paths) {
  try {
    return readJSON(path.join(paths.root, "update.json"), { phase: "idle" });
  } catch {
    return { phase: "recovery_required" };
  }
}
function settled(paths, journal) {
  return (
    terminalPhases.has(journal?.phase) &&
    !fs.existsSync(path.join(paths.root, "runtime-maintenance.json"))
  );
}

/** Each backup with its size and whether it may be deleted now (and why not). */
export async function listSnapshots({ dataDir, updates, maintenance = false }) {
  const paths = updates?.paths || filePaths(dataDir);
  const status = updates?.status();
  const journal = updates ? updates.journal : storedJournal(paths);
  const blocked = updates
    ? status.busy || status.recoveryRequired || !terminalPhases.has(journal.phase)
    : !settled(paths, journal);
  const backups = updates ? updates.backups() : listBackups(paths, journal);
  const budget = { entries: 2_000_000 };
  const result = [];
  for (const backup of backups) {
    const size = await measureTree(path.join(paths.root, "backups", backup.id), budget);
    const reason = backup.recovery
      ? "recovery"
      : blocked || maintenance
        ? "updating"
        : null;
    result.push({ ...backup, bytes: size.bytes, partial: size.partial, reason });
  }
  return { blocked: blocked || maintenance, snapshots: result };
}

/** Deletes one backup and its key; returns what was removed (never a path). */
export async function deleteSnapshot({ dataDir, updates, maintenance = false }, id) {
  if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id))
    throw cleanupProblem("notFound", 404);
  if (maintenance) throw cleanupProblem("updateRunning", 409);
  const paths = updates?.paths || filePaths(dataDir);
  const size = await measureTree(path.join(paths.root, "backups", id));
  if (updates) {
    try {
      const removed = await updates.deleteBackup(id);
      return { ...removed, bytes: size.bytes };
    } catch (error) {
      if (error.code === "UPDATE_BACKUP_NOT_FOUND") throw cleanupProblem("notFound", 404);
      if (error.status === 409) throw cleanupProblem("updateRunning", 409);
      throw error;
    }
  }
  const journal = storedJournal(paths);
  if (!settled(paths, journal)) throw cleanupProblem("updateRunning", 409);
  const found = listBackups(paths, journal).find((backup) => backup.id === id);
  if (!found) throw cleanupProblem("notFound", 404);
  await removeBackup(paths, id);
  return { ...found, bytes: size.bytes };
}
