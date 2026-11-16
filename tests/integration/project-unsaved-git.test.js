import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
  });
});

test("a worktree that does not answer in time is not checked", async (t) => {
  const base = await temp();
  t.after(() => rm(base, { recursive: true, force: true }));
  run(base, "init", "-b", "main");
  await writeFile(path.join(base, "a.txt"), "x\n");
  run(base, "add", ".");
  run(base, "commit", "-m", "x");
  const r = await unsavedGitWork(base, { timeoutMs: 1 });
  for (const w of r.worktrees) {
    assert.equal(w.checked, false);
    assert.equal(w.changes, null);
    assert.equal(w.unpushed, null);
  }
});
