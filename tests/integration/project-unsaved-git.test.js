import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { git as defaultGit } from "../../server/features/pipelines/workspace-git.js";
import { unsavedGitWork } from "../../server/features/projects/unsaved-git-work.js";

const run = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.test",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.test",
    },
  });

async function temp() {
  return realpath(await mkdtemp(path.join(os.tmpdir(), "unsaved-git-")));
}

test("reports uncommitted changes and commits on no remote, per worktree", async (t) => {
  const base = await temp();
  t.after(() => rm(base, { recursive: true, force: true }));
  const bare = path.join(base, "origin.git");
  const repo = path.join(base, "repo");
  const outside = path.join(base, "elsewhere");
  await mkdir(repo, { recursive: true });
  run(base, "init", "--bare", "-b", "main", bare);
  run(repo, "init", "-b", "main");
  run(repo, "remote", "add", "origin", bare);
  await writeFile(path.join(repo, "a.txt"), "one\n");
  run(repo, "add", ".");
  run(repo, "commit", "-m", "one");
  run(repo, "push", "origin", "main");
  await writeFile(path.join(repo, "a.txt"), "two\n");
  run(repo, "commit", "-am", "two");
  await writeFile(path.join(repo, "dirty.txt"), "x\n");
  run(repo, "worktree", "add", "-b", "wa", path.join(repo, ".worktrees", "a"));
  run(repo, "worktree", "add", "-b", "wb", path.join(repo, ".agentpier-worktrees", "b"));
  run(repo, "worktree", "add", "-b", "wc", outside);

  const r = await unsavedGitWork(repo);
  assert.equal(r.status, "ok");
  const main = r.worktrees.find((w) => w.path === repo);
  assert.equal(main.changes, 1);
  assert.equal(main.unpushed, 1);
  assert.equal(main.checked, true);
  assert.deepEqual(
    Object.fromEntries(r.worktrees.map((w) => [path.relative(base, w.path), w.inside])),
    {
      repo: true,
      [path.join("repo", ".worktrees", "a")]: true,
      [path.join("repo", ".agentpier-worktrees", "b")]: true,
      elsewhere: false,
    },
  );
  assert.ok(r.worktrees.every((w) => w.changes === (w.path === repo ? 1 : 0)));
  assert.equal(r.unpushedBranches, 1);
});

test("a plain folder reports none", async (t) => {
  const base = await temp();
  t.after(() => rm(base, { recursive: true, force: true }));
  assert.deepEqual(await unsavedGitWork(base), {
    status: "none",
    worktrees: [],
    unpushedBranches: null,
    worktreesChecked: true,
  });
});

test("a probe that does not answer in time is unchecked, not none", async (t) => {
  const base = await temp();
  t.after(() => rm(base, { recursive: true, force: true }));
  run(base, "init", "-b", "main");
  // A git that does not answer: killed at the bound like execFile's timeout. A real
  // 1 ms bound is not reliable, fast machines answer within it.
  const calls = [];
  const hanging = (cwd, args, { timeout }) => {
    calls.push(timeout);
    return new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            Object.assign(new Error("git timed out"), {
              code: null,
              killed: true,
              signal: "SIGTERM",
            }),
          ),
        timeout,
      ),
    );
  };
  const r = await unsavedGitWork(base, { timeoutMs: 5, git: hanging });
  assert.equal(r.status, "unchecked");
  assert.deepEqual(r.worktrees, []);
  assert.deepEqual(calls, [5]);
});

test("a failed worktree listing and failed counts are reported", async (t) => {
  const base = await temp();
  t.after(() => rm(base, { recursive: true, force: true }));
  run(base, "init", "-b", "main");
  await writeFile(path.join(base, "a.txt"), "x\n");
  run(base, "add", ".");
  run(base, "commit", "-m", "x");
  const failing = (args) => async (cwd, a, o) => {
    if (a[0] === args) throw new Error("timeout");
    return defaultGit(cwd, a, o);
  };
  const listing = await unsavedGitWork(base, { git: failing("worktree") });
  assert.equal(listing.status, "ok");
  assert.equal(listing.worktreesChecked, false);
  const partial = await unsavedGitWork(base, { git: failing("status") });
  assert.equal(partial.worktreesChecked, true);
  assert.equal(partial.worktrees[0].checked, false);
  assert.equal(partial.worktrees[0].changes, null);
  assert.equal(partial.worktrees[0].unpushed, 1);
});

test("a folder inside a larger repository reports only its own changes", async (t) => {
  const base = await temp();
  t.after(() => rm(base, { recursive: true, force: true }));
  run(base, "init", "-b", "main");
  await mkdir(path.join(base, "sub"));
  await writeFile(path.join(base, "sub", "a.txt"), "x\n");
  await writeFile(path.join(base, "other.txt"), "x\n");
  run(base, "add", ".");
  run(base, "commit", "-m", "x");
  await writeFile(path.join(base, "sub", "new.txt"), "y\n");
  await writeFile(path.join(base, "other.txt"), "changed\n");
  const sub = path.join(base, "sub");
  const r = await unsavedGitWork(sub);
  assert.equal(r.status, "ok");
  assert.equal(r.unpushedBranches, 0);
  assert.deepEqual(r.worktrees, [
    { path: sub, branch: null, inside: true, changes: 1, unpushed: 0, checked: true },
  ]);
});
