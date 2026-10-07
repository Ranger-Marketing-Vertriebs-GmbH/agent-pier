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

// Files that make a folder a project of its own, so it never counts as a collection.
const projectFiles = new Set([
  "package.json",
  "pyproject.toml",
  "setup.py",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "CMakeLists.txt",
  "Makefile",
  "deno.json",
  "mix.exs",
  "AGENTS.md",
  "CLAUDE.md",
]);
const isProjectFile = (name) => projectFiles.has(name) || /^readme(\.|$)/i.test(name);

/**
 * Counts direct child folders that are Git projects: repositories (a `.git` entry)
 * or folders a Git project is registered for. Hidden folders, symbolic links and
 * files never count. Returns -1 when the folder has a `.git` entry or a project file
 * of its own. Stops counting at `enough`.
 */
function childProjects(folder, isGitProject, enough) {
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
      if (entry.name === ".git" || (!entry.isDirectory() && isProjectFile(entry.name)))
        return -1;
      if (!entry.isDirectory() || entry.name.startsWith(".") || found >= enough) continue;
      const child = path.join(folder, entry.name);
      if (fs.existsSync(path.join(child, ".git")) || isGitProject(child)) found++;
    }
  } finally {
    directory.closeSync();
  }
  return found;
}

/**
 * Decides whether a session folder stands for a project:
 * - `home`: exactly the user's home folder. Folders below it are classified like any
 *   other folder, also when the home folder is a Git work tree (dotfiles).
 * - `collection`: a folder that only groups projects. Conservative rule: it has no
 *   `.git` entry and no project file of its own (package.json, README, Makefile, ...),
 *   is not inside a Git work tree, and at least two of its direct, non-hidden child
 *   folders are Git repositories or registered Git projects.
 * - `project`: everything else. A pipeline run worktree resolves to its project root.
 * A home or collection folder whose registered project holds memory entries stays a
 * project, so existing knowledge keeps working. Git runs only for collection
 * candidates; `scope` is the folder's project scope when it was read, else null.
 */
export async function classifyProjectFolder(
  cwd,
  { home, isGitProject = () => false, holdsKnowledge = () => false },
) {
  let canonical = realpath(cwd);
  if (!canonical) return { kind: "project", cwd, scope: null };
  const root = runWorktreeRoot(canonical);
  if (root) canonical = realpath(root) || root;
  const project = { kind: "project", cwd: canonical, scope: null };
  const homeFolder = home ? realpath(home) : null;
  if (canonical === homeFolder)
    return holdsKnowledge(canonical) ? project : { ...project, kind: "home" };
  if (childProjects(canonical, isGitProject, 2) < 2) return project;
  let scope;
  try {
    scope = await projectScope(canonical);
  } catch {
    return project;
  }
  if (scope.kind === "git" || holdsKnowledge(canonical)) return { ...project, scope };
  return { kind: "collection", cwd: canonical, scope };
}
