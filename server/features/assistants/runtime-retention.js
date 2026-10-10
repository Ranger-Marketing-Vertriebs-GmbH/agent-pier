import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { readJSON } from "../../lib/storage.js";
import { destroyBackupKey } from "./backup-credentials.js";
import { acquireInstallLock } from "./runtime-install-lock.js";

const keepSuccessful = 2;
const staleMs = 60 * 60 * 1000;
const backupId = /^[a-f0-9-]{36}$/;
export const terminalPhases = new Set(["idle", "staged", "complete", "rolled_back"]);

/** Marks a committed update's backup as one of the successful ones retention keeps. */
export function markBackupSuccessful(paths, id) {
  if (!backupId.test(id || "")) return;
  const file = path.join(paths.root, "backups", id, "committed");
  try {
    // An existing marker keeps its original commit time.
    fs.writeFileSync(file, new Date().toISOString(), { mode: 0o600, flag: "wx" });
  } catch (error) {
    if (!["EEXIST", "ENOENT"].includes(error.code)) throw error;
  }
}
async function removeBackup(paths, id) {
  destroyBackupKey(paths.root, id);
  await fsp.rm(path.join(paths.root, "backups", id), { recursive: true, force: true });
}
/**
 * Keeps the newest successful backups and the backup an unresolved update may still
 * restore; removes every other backup together with its key.
 */
export async function pruneBackups(paths, journal) {
  const folder = path.join(paths.root, "backups");
  if (!fs.existsSync(folder)) return;
  const unresolved = !terminalPhases.has(journal?.phase) ? journal?.backup : null;
  const successful = [];
  for (const id of fs.readdirSync(folder)) {
    if (!backupId.test(id) || id === unresolved) continue;
    const marker = committedAt(path.join(folder, id, "committed"));
    if (marker !== null) successful.push({ id, marker });
    else await removeBackup(paths, id);
  }
  successful.sort((a, b) => (b.marker > a.marker ? 1 : b.marker < a.marker ? -1 : 0));
  for (const { id } of successful.slice(keepSuccessful)) await removeBackup(paths, id);
}
function committedAt(file) {
  try {
    return fs.statSync(file, { bigint: true }).mtimeNs;
  } catch {
    return null;
  }
}
function runtimeIdentity(paths, descriptor) {
  if (typeof descriptor?.nodePath !== "string") return null;
  const relative = path.relative(paths.runtimes, path.resolve(descriptor.nodePath));
  const name = relative.split(path.sep)[0];
  return relative.startsWith("..") || path.isAbsolute(relative) || !name ? null : name;
}
/**
 * Deletes installed runtimes no selection, candidate or rollback target refers to.
 * Any selection without a resolvable runtime path disables pruning entirely. The
 * selection and candidate are read under the install lock, under which installers
 * record their candidate, so a runtime installed concurrently is never unreferenced.
 */
export async function pruneRuntimes(paths, journal) {
  let release;
  try {
    release = acquireInstallLock(paths);
  } catch (error) {
    if (error.code === "RUNTIME_BUSY") return;
    throw error;
  }
  try {
    const descriptors = [
      readJSON(path.join(paths.root, "runtime.json"), null),
      readJSON(path.join(paths.root, "candidate.json"), null),
      ...(terminalPhases.has(journal?.phase)
        ? []
        : [journal?.previous, journal?.candidate]),
    ].filter(Boolean);
    const referenced = new Set();
    for (const descriptor of descriptors) {
      const name = runtimeIdentity(paths, descriptor);
      if (!name) return;
      referenced.add(name);
    }
    for (const name of fs.readdirSync(paths.runtimes))
      if (!name.startsWith(".") && !referenced.has(name))
        await fsp.rm(path.join(paths.runtimes, name), { recursive: true, force: true });
  } finally {
    release();
  }
}
function list(folder) {
  try {
    return fs.readdirSync(folder);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
/**
 * Startup sweep. No snapshot runs during startup, so every snapshot work file is
 * abandoned; installation stages older than an hour are removed under the install
 * lock (another process may be installing right now).
 */
export async function sweepAssistantStorage(paths, now = Date.now()) {
  for (const name of list(paths.tmp))
    if (name.startsWith("snapshot-"))
      await fsp.rm(path.join(paths.tmp, name), { recursive: true, force: true });
  const stages = list(paths.runtimes).filter((name) => name.startsWith(".stage-"));
  if (!stages.length) return;
  let release;
  try {
    release = acquireInstallLock(paths);
  } catch (error) {
    if (error.code === "RUNTIME_BUSY") return;
    throw error;
  }
  try {
    for (const name of stages) {
      const file = path.join(paths.runtimes, name);
      const stat = await fsp.lstat(file).catch(() => null);
      if (stat && now - stat.mtimeMs > staleMs)
        await fsp.rm(file, { recursive: true, force: true });
    }
  } finally {
    release();
  }
}
export async function applyRetention(paths, journal) {
  await pruneBackups(paths, journal);
  await pruneRuntimes(paths, journal);
}
