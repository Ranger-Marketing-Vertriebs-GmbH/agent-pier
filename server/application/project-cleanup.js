import fs from "node:fs";
import path from "node:path";
import { gitInitRebind } from "../features/memory/project-rebind.js";
import { projectScope } from "../features/memory/project-scope.js";
import { runWorktreeRoot } from "../features/memory/project-folders.js";

/** The marker this one-off cleanup records in the memory database. */
export const cleanupName = "2026-10-project-list-identity";
const backupLabel = "before-project-cleanup";

/** Session records, or null when one cannot be read (nothing may be removed then). */
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
      return null;
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
 * pipeline runs. Such rows are never removed. Every check fails closed: a source
 * that cannot be read keeps every row.
 */
function attachment(services) {
  const sessions = sessionRecords(services.config.dataDir);
  const runs = services.pipelines.store.all();
  return (row) =>
    !sessions ||
    services.memory.ownsEntries(row.id) ||
    services.memory.heldBySession(row.id) ||
    sessions.some(
      (session) =>
        session.text.includes(row.id) ||
        (typeof session.cwd === "string" && realpath(session.cwd) === row.cwd),
    ) ||
    services.sshManagement.knowsProject(row.id) ||
    services.artifacts.ownsProject(row.id) ||
    services.pipelineDefinitions.hasVerification(row.id) ||
    runs.some((run) => run.projectId === row.id);
}

/**
 * The same-folder duplicates a `git init` left behind: the plain-folder row passes
 * the strict rebind rule (same folder, its own fresh `.git`). Whether it may move is
 * decided by ProjectRebind, exactly as at registration.
 */
async function duplicates(rows) {
  const byFolder = new Map();
  for (const row of rows) byFolder.set(row.cwd, [...(byFolder.get(row.cwd) || []), row]);
  const found = [];
  for (const [cwd, group] of byFolder) {
    if (group.length < 2) continue;
    const rebind = await gitInitRebind(cwd);
    if (rebind && group.some((row) => row.id === rebind.fromId)) found.push(rebind);
  }
  return found;
}

/** Recorded rebinds whose SSH, artifact, verification or session move is unfinished. */
async function unfinishedMoves({ memory, projectRebind }) {
  const moves = [];
  for (const { from_id: fromId, to_id: toId } of memory.db
    .prepare("SELECT from_id,to_id FROM project_rebinds")
    .all()) {
    if (!memory.hasProject(toId) || !projectRebind.remnants(fromId)) continue;
    const found = await gitInitRebind(memory.project(toId).cwd);
    if (found?.fromId === fromId && found.scope.id === toId) moves.push(found);
  }
  return moves;
}

function backup(memory) {
  // A retried cleanup reuses the backup of its first attempt.
  const existing = fs
    .readdirSync(memory.root)
    .find((name) => name.startsWith(`memory.sqlite.${backupLabel}-`));
  return existing ? path.join(memory.root, existing) : memory.backup(backupLabel);
}

/**
 * One-off startup cleanup of the project list, recorded in the memory database once
 * it completed. It
 * - moves same-folder duplicates a `git init` left behind through ProjectRebind, with
 *   the rule registration uses (a Git identity that owns data keeps its own row), and
 *   retries moves a previous attempt left unfinished;
 * - points rows a pipeline run worktree registered first at their project root;
 * - removes rows for the home folder, collection folders and run worktrees when
 *   nothing refers to them, and audits each removal.
 * Rows with memory entries or sessions stay listed. Files on disk are never touched;
 * the memory database is backed up next to itself before the first change.
 */
export async function cleanUpProjects(services) {
  const { memory, projectRebind, audit } = services;
  if (memory.migrationApplied(cleanupName)) return null;
  const rows = memory.db.prepare("SELECT id,cwd,kind FROM projects").all();
  const merges = await duplicates(rows);
  const moves = await unfinishedMoves(services);
  const merging = new Set(merges.map((found) => found.fromId));
  const relocations = [],
    candidates = [];
  for (const row of rows) {
    if (merging.has(row.id)) continue;
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
  if (merges.length || moves.length || relocations.length || removals.length)
    summary.backup = backup(memory);
  let complete = true;
  for (const found of merges) {
    // Records the rebind, audits it and moves memory, SSH, artifacts, verification
    // and sessions; null when the Git identity owns data of its own.
    try {
      if (
        await projectRebind.rebind({
          cwd: found.launch.path,
          previousIds: [found.fromId],
        })
      )
        summary.merged++;
    } catch {
      complete = false;
    }
  }
  for (const found of moves)
    try {
      await projectRebind.serial(() => projectRebind.adopt(found, [found.fromId]));
    } catch {
      complete = false;
    }
  for (const { id, scope } of relocations) {
    memory.relocate(id, scope);
    summary.relocated++;
  }
  for (const row of removals)
    if (memory.removeEmpty(row.id)) {
      summary.removed++;
      audit.append({
        action: "project.deleted",
        resourceType: "project",
        resourceId: row.id,
        projectId: row.id,
        source: "system",
        outcome: "success",
      });
    }
  for (const found of [...merges, ...moves])
    if (memory.reboundTo(found.fromId) && projectRebind.remnants(found.fromId))
      complete = false;
  // An unfinished move keeps the marker unset, so the next start retries it.
  if (complete) memory.recordMigration(cleanupName);
  return { ...summary, complete };
}
