import fs from "node:fs";
import path from "node:path";
import { gitInitRebind } from "../features/memory/project-rebind.js";
import { projectScope } from "../features/memory/project-scope.js";
import { runWorktreeRoot } from "../features/memory/project-folders.js";

/** The marker this one-off cleanup records in the memory database. */
export const cleanupName = "2026-10-project-list-identity";

function sessionRecords(dataDir) {
  const directory = path.join(dataDir, "sessions");
  let names = [];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const records = [];
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}\.json$/.test(name)) continue;
    try {
      const text = fs.readFileSync(path.join(directory, name), "utf8");
      records.push({ text, cwd: JSON.parse(text).cwd });
    } catch {
      // An unreadable record is skipped here; it cannot pin a project either way.
    }
  }
  return records;
}
function realpath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

/**
 * Something other than the project row refers to the project or its folder: a
 * session (record or memory capability), SSH, artifacts, pipeline verification or
 * pipeline runs. Such rows are never removed.
 */
function attachment(services) {
  const sessions = sessionRecords(services.config.dataDir);
  const runs = services.pipelines?.store?.all?.() || [];
  return (row) =>
    services.memory.ownsEntries(row.id) ||
    services.memory.heldBySession(row.id) ||
    sessions.some(
      (session) =>
        session.text.includes(row.id) ||
        (typeof session.cwd === "string" && realpath(session.cwd) === row.cwd),
    ) ||
    Boolean(services.sshManagement?.knowsProject(row.id)) ||
    Boolean(services.artifacts?.ownsProject(row.id)) ||
    Boolean(services.pipelineDefinitions?.hasVerification(row.id)) ||
    runs.some((run) => run.projectId === row.id);
}

/** Plans the duplicate merges: a plain-folder row and the Git identity of its `git init`. */
async function duplicates(rows, services) {
  const byFolder = new Map();
  for (const row of rows) byFolder.set(row.cwd, [...(byFolder.get(row.cwd) || []), row]);
  const merges = [];
  for (const [cwd, group] of byFolder) {
    if (group.length < 2) continue;
    const found = await gitInitRebind(cwd);
    if (!found || !group.some((row) => row.id === found.fromId)) continue;
    // A Git identity with SSH access of its own stays strictly separate.
    if (services.sshManagement?.ownsProject(found.scope.id)) continue;
    merges.push(found);
  }
  return merges;
}

/**
 * One-off startup cleanup of the project list, recorded in the memory database so
 * it runs once. It merges same-folder rows a `git init` left behind, points rows a
 * pipeline run worktree registered first at their project root, and removes rows
 * for the home folder, collection folders and run worktrees when nothing refers to
 * them. Rows with memory entries or sessions stay listed. Files on disk are never
 * touched; the memory database is backed up next to itself before any change.
 */
export async function cleanUpProjects(services) {
  const { memory, projectRebind } = services;
  if (memory.migrationApplied(cleanupName)) return null;
  const rows = memory.db.prepare("SELECT id,cwd,kind FROM projects").all();
  const merges = await duplicates(rows, services);
  const merged = new Set(merges.map((found) => found.fromId));
  const relocations = [],
    candidates = [];
  for (const row of rows) {
    if (merged.has(row.id)) continue;
    const root = runWorktreeRoot(row.cwd);
    if (root) {
      let scope = null;
      try {
        scope = await projectScope(root);
      } catch {
        // A removed project root leaves only the removal of an empty row.
      }
      const taken = rows.some((other) => other.cwd === root && other.id !== row.id);
      if (scope?.id === row.id && scope.cwd === root && !taken)
        relocations.push({ id: row.id, scope });
      else candidates.push(row);
      continue;
    }
    if (!fs.existsSync(row.cwd)) continue;
    const folder = await memory.classifyFolder(row.cwd);
    if (folder.kind !== "project" && folder.cwd === row.cwd) candidates.push(row);
  }
  const attached = attachment(services);
  const removals = candidates.filter((row) => !attached(row));
  const summary = { merged: 0, relocated: 0, removed: 0, backup: null };
  if (merges.length || relocations.length || removals.length)
    summary.backup = memory.backup("before-project-cleanup");
  for (const found of merges) {
    memory.merge(found.fromId, found.scope);
    summary.merged++;
    try {
      // Moves SSH, artifacts, verification and session bindings after the rebind.
      await projectRebind?.serial(() => projectRebind.adopt(found, [found.fromId]));
    } catch {
      // The recorded rebind lets a later session call finish the move.
    }
  }
  for (const { id, scope } of relocations) {
    memory.relocate(id, scope);
    summary.relocated++;
  }
  for (const row of removals) if (memory.removeEmpty(row.id)) summary.removed++;
  memory.recordMigration(cleanupName);
  return summary;
}
