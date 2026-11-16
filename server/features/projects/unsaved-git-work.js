import { realpath } from "node:fs/promises";
import path from "node:path";
import { git as defaultGit } from "../pipelines/workspace-git.js";
import { parseWorktrees } from "../changes/session-workspaces.js";
import { inside } from "./deletion-paths.js";

const real = (target) => realpath(target).catch(() => target);

async function count(run, cwd, args, timeout) {
  try {
    const out = await run(cwd, args, { timeout });
    const number = Number.parseInt(out, 10);
    return Number.isInteger(number) ? number : null;
  } catch {
    return null;
  }
}

// Worktrees nested in this one show up as untracked folders; they are listed
// on their own, so they are left out of the count here.
async function statusLines(run, cwd, pathspecs, timeout) {
  try {
    const out = await run(
      cwd,
      ["status", "--porcelain", "--untracked-files=normal", "--", ...pathspecs],
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
 * counts null and `checked` false. Status is "none" only when git says the folder
 * is no repository (exit 128); any other failure of that probe is "unchecked", and
 * a failed worktree listing sets `worktreesChecked` false.
 *
 * `unpushedBranches` is the number of commits on local branches that no remote has
 * (the name is the Task 6 interface). When `folder` is only a part of a larger
 * repository, the repository survives the deletion: one entry reports the
 * folder's own uncommitted changes and nothing counts as unpushed.
 */
export async function unsavedGitWork(
  folder,
  { timeoutMs = 10000, git: run = defaultGit } = {},
) {
  let top;
  try {
    top = await run(folder, ["rev-parse", "--show-toplevel"], { timeout: timeoutMs });
  } catch (error) {
    return {
      status: error?.code === 128 ? "none" : "unchecked",
      worktrees: [],
      unpushedBranches: null,
      worktreesChecked: true,
    };
  }
  if (!top)
    return {
      status: "none",
      worktrees: [],
      unpushedBranches: null,
      worktreesChecked: true,
    };

  const folderReal = await real(folder);
  const topReal = await real(top);
  if (topReal !== folderReal) {
    const changes = await statusLines(
      run,
      topReal,
      [`:(top,literal)${path.relative(topReal, folderReal)}`],
      timeoutMs,
    );
    return {
      status: "ok",
      worktrees: [
        {
          path: folder,
          branch: null,
          inside: true,
          changes,
          unpushed: 0,
          checked: changes !== null,
        },
      ],
      unpushedBranches: 0,
      worktreesChecked: true,
    };
  }

  let entries;
  let worktreesChecked = true;
  try {
    entries = parseWorktrees(
      await run(top, ["worktree", "list", "--porcelain", "-z"], { timeout: timeoutMs }),
    );
  } catch {
    entries = [];
    worktreesChecked = false;
  }
  if (entries.length === 0) entries = [{ path: top, branch: null, bare: false }];

  const worktrees = [];
  for (const entry of entries) {
    if (entry.bare) continue;
    const nested = entries
      .filter((other) => other !== entry && inside(entry.path, other.path))
      .map((other) => `:(exclude,top,literal)${path.relative(entry.path, other.path)}`);
    const [changes, unpushed] = await Promise.all([
      statusLines(run, entry.path, [".", ...nested], timeoutMs),
      count(
        run,
        entry.path,
        ["rev-list", "--count", "HEAD", "--not", "--remotes"],
        timeoutMs,
      ),
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
    run,
    top,
    ["rev-list", "--count", "--branches", "--not", "--remotes"],
    timeoutMs,
  );
  return { status: "ok", worktrees, unpushedBranches, worktreesChecked };
}
