// The workspaces of a session (its directory and the worktrees under the repository's
// `.worktrees/`) and the commit each one is diffed against. A client names a
// workspace only by the `id` listed here; ids are never used as paths.
import fs from "node:fs/promises";
import path from "node:path";
import { exactCommit, git } from "../pipelines/workspace-git.js";
import { remoteDefaultBranch } from "../tickets/ticket-worktree.js";

export const MAX_WORKSPACES = 50;
const EMPTY_TREE_ARGS = ["hash-object", "-t", "tree", "/dev/null"];

/**
 * @typedef {{ id: string, path: string, branch: string|null, head: string|null }} Workspace
 * @typedef {{ name: string, ref: string }} DefaultBranch
 * @typedef {{ kind: "merge-base"|"start-commit"|"head", sha: string, ref?: string }} Base
 */

const real = (target) => fs.realpath(target).catch(() => null);
const posix = (value) => value.split(path.sep).join("/");

/** Parses `git worktree list --porcelain -z`; the first entry is the main worktree. */
function parseWorktrees(output) {
  const entries = [];
  let current = null;
  for (const field of output.split("\0")) {
    if (field === "") {
      current = null;
      continue;
    }
    const space = field.indexOf(" ");
    const key = space === -1 ? field : field.slice(0, space);
    const value = space === -1 ? "" : field.slice(space + 1);
    if (key === "worktree") {
      current = { path: value, head: null, branch: null, bare: false };
      entries.push(current);
    } else if (!current) continue;
    else if (key === "HEAD") current.head = /^0+$/.test(value) ? null : value;
    else if (key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (key === "bare") current.bare = true;
  }
  return entries;
}

/**
 * The session's git toplevel first, then the `.worktrees/` worktrees by id. Null when
 * `sessionDir` is no repository.
 * @returns {Promise<{ root: string, workspaces: Workspace[] }|null>}
 */
export async function listWorkspaces(sessionDir) {
  let toplevel;
  let listing;
  try {
    toplevel = await real(
      (await git(sessionDir, ["rev-parse", "--show-toplevel"])).trim(),
    );
    if (!toplevel) return null;
    listing = await git(toplevel, ["worktree", "list", "--porcelain", "-z"]);
  } catch {
    return null;
  }
  const entries = parseWorktrees(listing);
  const mainRoot = entries[0] ? await real(entries[0].path) : null;
  const managed = mainRoot ? path.join(mainRoot, ".worktrees") + path.sep : null;
  const found = [];
  for (const entry of entries) {
    if (entry.bare) continue;
    const resolved = await real(entry.path);
    if (!resolved) continue;
    const isSession = resolved === toplevel;
    // a link swapped in for the listed path would point elsewhere
    if (!isSession && (resolved !== path.resolve(entry.path) || !managed)) continue;
    if (!isSession && !resolved.startsWith(managed)) continue;
    found.push({
      id: isSession ? "" : posix(path.relative(toplevel, resolved)),
      path: resolved,
      branch: entry.branch,
      head: entry.head,
    });
  }
  found.sort((a, b) => (a.id === "" ? -1 : b.id === "" ? 1 : a.id < b.id ? -1 : 1));
  return { root: toplevel, workspaces: found.slice(0, MAX_WORKSPACES) };
}

const hasRef = (cwd, ref) =>
  git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    .then(Boolean)
    .catch(() => false);

/** `origin`'s default branch, else a local `main` or `master`, else null. */
export async function resolveDefaultBranch(root) {
  try {
    const name = await remoteDefaultBranch(root);
    return { name, ref: `refs/remotes/origin/${name}` };
  } catch {
    for (const name of ["main", "master"])
      if (await hasRef(root, `refs/heads/${name}`))
        return { name, ref: `refs/heads/${name}` };
    return null;
  }
}

/**
 * The commit a workspace is diffed against: a branch other than the default one uses
 * the merge-base with the default branch; the default branch and a detached HEAD use
 * the session's start commit (the session directory) or HEAD.
 * @returns {Promise<Base>}
 */
export async function workspaceBase(
  workspace,
  { isSessionDir, defaultBranch, startCommit },
) {
  if (workspace.branch && defaultBranch && workspace.branch !== defaultBranch.name) {
    try {
      const sha = await exactCommit(
        workspace.path,
        (await git(workspace.path, ["merge-base", "HEAD", defaultBranch.ref])).trim(),
      );
      return { kind: "merge-base", sha, ref: defaultBranch.ref };
    } catch {
      // unrelated histories: fall through to HEAD
    }
  }
  if (isSessionDir && startCommit && /^[a-f0-9]{40,64}$/.test(startCommit)) {
    try {
      return {
        kind: "start-commit",
        sha: await exactCommit(workspace.path, startCommit),
      };
    } catch {
      // the commit was lost (gc, a different clone)
    }
  }
  const sha =
    workspace.head ?? (await git(workspace.path, EMPTY_TREE_ARGS).catch(() => "")).trim();
  return { kind: "head", sha };
}
