import { realpath } from "node:fs/promises";
import path from "node:path";
import { git } from "../pipelines/workspace-git.js";
import { parseWorktrees } from "../changes/session-workspaces.js";
import { inside } from "./deletion-paths.js";

const real = (target) => realpath(target).catch(() => target);

async function count(cwd, args, timeout) {
  try {
    const out = await git(cwd, args, { timeout });
    const number = Number.parseInt(out, 10);
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

// Worktrees nested in this one show up as untracked folders; they are listed
// on their own, so they are left out of the count here.
async function statusLines(cwd, nested, timeout) {
  const excludes = nested.map((child) => `:(exclude,top)${path.relative(cwd, child)}`);
  try {
    const out = await git(
      cwd,
      ["status", "--porcelain", "--untracked-files=normal", "--", ".", ...excludes],
      { timeout },
    );
    return out === "" ? 0 : out.split("\n").length;
  } catch {
    return null;
  }
}

/**
 * Uncommitted changes and commits that no remote has, for the repository around
 * `folder` and each of its worktrees. A call that fails or times out leaves the
 * counts null and `checked` false.
 */
export async function unsavedGitWork(folder, { timeoutMs = 10000 } = {}) {
  let top;
  try {
    top = await git(folder, ["rev-parse", "--show-toplevel"], { timeout: timeoutMs });
  } catch {
    return { status: "none", worktrees: [], unpushedBranches: null };
  }
  if (!top) return { status: "none", worktrees: [], unpushedBranches: null };

  let entries = [];
  try {
    entries = parseWorktrees(
      await git(top, ["worktree", "list", "--porcelain", "-z"], { timeout: timeoutMs }),
    );
  } catch {
    entries = [];
  }
  if (entries.length === 0) entries = [{ path: top, branch: null, bare: false }];

  const folderReal = await real(folder);
  const worktrees = [];
  for (const entry of entries) {
    if (entry.bare) continue;
    const [changes, unpushed] = await Promise.all([
      statusLines(
        entry.path,
        entries
          .filter((other) => other !== entry && inside(entry.path, other.path))
          .map((other) => other.path),
        timeoutMs,
      ),
      count(entry.path, ["rev-list", "--count", "HEAD", "--not", "--remotes"], timeoutMs),
    ]);
    worktrees.push({
      path: entry.path,
      branch: entry.branch,
      inside: inside(folderReal, await real(entry.path)),
      changes,
      unpushed,
      checked: changes !== null && unpushed !== null,
    });
  }
  const unpushedBranches = await count(
    top,
    ["rev-list", "--count", "--branches", "--not", "--remotes"],
    timeoutMs,
  );
  return { status: "ok", worktrees, unpushedBranches };
}
