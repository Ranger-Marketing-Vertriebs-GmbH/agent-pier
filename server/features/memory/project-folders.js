import fs from "node:fs";
import path from "node:path";
import { projectScope } from "./project-scope.js";

/** Pipeline runs check their project out below `<project>/.agentpier-worktrees/`. */
export const runFence = ".agentpier-worktrees";
const childScanLimit = 2000;

/** The project root of a pipeline run worktree (or a folder inside one), else null. */
export function runWorktreeRoot(cwd) {
  const parts = String(cwd || "").split(path.sep);
  const index = parts.indexOf(runFence);
  if (index < 1) return null;
  return parts.slice(0, index).join(path.sep) || path.sep;
}

function realpath(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return null;
  }
}

/**
 * Counts direct child folders that are projects: Git repositories (a `.git` entry)
 * or folders a project is registered for. Hidden folders, symbolic links and
 * files never count. Stops at `enough`.
 */
function childProjects(folder, isRegistered, enough) {
  let found = 0,
    seen = 0,
    directory;
  try {
    directory = fs.opendirSync(folder);
  } catch {
    return 0;
  }
  try {
    for (let entry; (entry = directory.readSync()) && seen < childScanLimit; seen++) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const child = path.join(folder, entry.name);
      if (fs.existsSync(path.join(child, ".git")) || isRegistered(child))
        if (++found >= enough) break;
    }
  } finally {
    directory.closeSync();
  }
  return found;
}

/**
 * Decides whether a session folder stands for a project:
 * - `home`: the user's home folder, or a folder whose Git work tree is the home folder.
 * - `collection`: a folder that only groups projects. Conservative rule: it is not
 *   inside a Git work tree, and at least two of its direct, non-hidden child folders
 *   are Git repositories or registered projects.
 * - `project`: everything else. A pipeline run worktree resolves to its project root.
 * `scope` is the folder's project scope when it was read (null when unavailable).
 */
export async function classifyProjectFolder(cwd, { home, isRegistered = () => false }) {
  let canonical = realpath(cwd);
  if (!canonical) return { kind: "project", cwd, scope: null };
  const root = runWorktreeRoot(canonical);
  if (root) canonical = realpath(root) || root;
  const homeFolder = home ? realpath(home) : null;
  if (canonical === homeFolder) return { kind: "home", cwd: canonical, scope: null };
  let scope = null;
  try {
    scope = await projectScope(canonical);
  } catch {
    return { kind: "project", cwd: canonical, scope: null };
  }
  if (scope.kind === "git") {
    if (scope.cwd === homeFolder) return { kind: "home", cwd: canonical, scope };
    return { kind: "project", cwd: canonical, scope };
  }
  if (childProjects(canonical, isRegistered, 2) >= 2)
    return { kind: "collection", cwd: canonical, scope };
  return { kind: "project", cwd: canonical, scope };
}
