import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { projectScope } from "./project-scope.js";

/**
 * The one project identity change that keeps a running session's accesses: the
 * same folder (same realpath, device and inode) changed from a plain directory
 * to a Git work tree rooted at that folder, with its own `.git` directory inside
 * it. Every other change (a replaced folder, a parent repository, a separate or
 * linked Git directory, Git to plain directory) is not a rebind.
 */
export function directoryProjectId(launch) {
  const identity = JSON.stringify(["directory", launch.path, launch.dev, launch.ino]);
  return createHash("sha256").update(identity).digest("hex");
}
export function folderIdentity(cwd) {
  const canonical = fs.realpathSync(cwd);
  const stat = fs.statSync(canonical, { bigint: true });
  if (!stat.isDirectory()) throw Error("Not a directory");
  return { path: canonical, dev: String(stat.dev), ino: String(stat.ino) };
}
export function sameFolder(a, b) {
  return Boolean(a && b && a.path === b.path && a.dev === b.dev && a.ino === b.ino);
}
/** `launch` is the folder identity when the plain-directory project was bound. */
export function isGitInitOf(launch, scope) {
  if (scope?.kind !== "git" || scope.cwd !== launch?.path) return false;
  let identity;
  try {
    identity = JSON.parse(scope.identity);
  } catch {
    return false;
  }
  const gitDirectory = path.join(launch.path, ".git");
  if (!Array.isArray(identity) || identity[0] !== "git" || identity[1] !== gitDirectory)
    return false;
  try {
    const stat = fs.lstatSync(gitDirectory);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}
/** Grant project IDs with each rebound plain project replaced by its Git project. */
export function reboundProjectIds(projectIds, memory) {
  return [...new Set(projectIds.map((id) => memory?.reboundTo?.(id) || id))];
}
/**
 * Returns `{ fromId, scope, launch }` when `cwd` is a folder that became the root
 * of its own fresh Git work tree, so `fromId` (its plain-directory identity) and
 * `scope.id` name the same project. Returns null for every other state.
 */
export async function gitInitRebind(cwd) {
  let before, scope, after;
  try {
    before = folderIdentity(cwd);
    scope = await projectScope(cwd);
    after = folderIdentity(cwd);
  } catch {
    return null;
  }
  if (!sameFolder(before, after) || !isGitInitOf(before, scope)) return null;
  return { fromId: directoryProjectId(before), scope, launch: before };
}
