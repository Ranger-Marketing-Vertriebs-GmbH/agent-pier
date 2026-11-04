import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  MAX_WORKSPACES,
  listWorkspaces,
  resolveDefaultBranch,
  workspaceBase,
} from "../../server/features/changes/session-workspaces.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "ws-home-"));
process.env.HOME = home;
process.on("exit", () => fs.rmSync(home, { recursive: true, force: true }));
const env = {
  ...process.env,
  HOME: home,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const run = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function commit(repo, name, content) {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  run(repo, "add", ".");
  run(repo, "commit", "-m", name);
  return run(repo, "rev-parse", "HEAD");
}
function localRepo(t) {
  const repo = path.join(tmp(t, "ws-repo-"), "repo");
  fs.mkdirSync(repo);
  run(repo, "init", "-b", "main");
  commit(repo, ".gitignore", ".worktrees/\n.agentpier-worktrees/\n");
  commit(repo, "server/a.js", "a\n");
  return repo;
}
function repoWithOrigin(t) {
  const dir = tmp(t, "ws-origin-");
  run(dir, "init", "--bare", "-b", "main", "origin.git");
  const repo = path.join(dir, "repo");
  run(dir, "clone", "origin.git", repo);
  commit(repo, ".gitignore", ".worktrees/\n");
  run(repo, "push", "origin", "HEAD:main");
  run(repo, "fetch", "origin");
  run(repo, "remote", "set-head", "origin", "main");
  return repo;
}

test("the session directory and .worktrees/ worktrees are listed, nothing else", async (t) => {
  const repo = localRepo(t);
  run(repo, "worktree", "add", "-b", "feat/x", ".worktrees/feat/x");
  run(repo, "worktree", "add", "-b", "run1", ".agentpier-worktrees/run1");
  run(repo, "worktree", "add", "-b", "outside", path.join(tmp(t, "ws-out-"), "o"));
  const { workspaces } = await listWorkspaces(repo);
  assert.deepEqual(
    workspaces.map((w) => [w.id, w.branch]),
    [
      ["", "main"],
      [".worktrees/feat/x", "feat/x"],
    ],
  );
  assert.equal(workspaces[0].path, fs.realpathSync(repo));
  assert.match(workspaces[1].head, /^[a-f0-9]{40}$/);
});

test("a session inside a worktree lists its siblings relative to itself", async (t) => {
  const repo = localRepo(t);
  run(repo, "worktree", "add", "-b", "feat/x", ".worktrees/feat/x");
  run(repo, "worktree", "add", "-b", "feat/y", ".worktrees/feat/y");
  const { workspaces } = await listWorkspaces(path.join(repo, ".worktrees/feat/x"));
  assert.deepEqual(
    workspaces.map((w) => w.id),
    ["", "../y"],
  );
});

test("a subfolder session uses its repository toplevel", async (t) => {
  const repo = localRepo(t);
  const listed = await listWorkspaces(path.join(repo, "server"));
  assert.equal(listed.root, fs.realpathSync(repo));
  assert.equal(listed.workspaces[0].id, "");
});

test("bases: feature branch is merge-base, default or detached is start commit or HEAD", async (t) => {
  const repo = repoWithOrigin(t);
  const start = run(repo, "rev-parse", "HEAD");
  run(repo, "worktree", "add", "-b", "feat/x", ".worktrees/feat/x");
  const featurePath = path.join(repo, ".worktrees/feat/x");
  commit(featurePath, "f.txt", "f\n");
  run(repo, "worktree", "add", "--detach", ".worktrees/det");
  const { workspaces } = await listWorkspaces(repo);
  const byId = Object.fromEntries(workspaces.map((w) => [w.id, w]));
  const defaultBranch = await resolveDefaultBranch(repo);
  assert.deepEqual(defaultBranch, { name: "main", ref: "refs/remotes/origin/main" });

  const feature = await workspaceBase(
    { ...byId[".worktrees/feat/x"], head: run(featurePath, "rev-parse", "HEAD") },
    { isSessionDir: false, defaultBranch, startCommit: null },
  );
  assert.deepEqual(feature, { kind: "merge-base", sha: start, ref: defaultBranch.ref });
  assert.deepEqual(
    await workspaceBase(byId[""], {
      isSessionDir: true,
      defaultBranch,
      startCommit: start,
    }),
    { kind: "start-commit", sha: start },
  );
  const detached = await workspaceBase(byId[".worktrees/det"], {
    isSessionDir: false,
    defaultBranch,
    startCommit: start,
  });
  assert.deepEqual(detached, { kind: "head", sha: start });
  const sessionOnFeature = {
    ...byId[".worktrees/feat/x"],
    head: run(featurePath, "rev-parse", "HEAD"),
  };
  assert.equal(
    (
      await workspaceBase(sessionOnFeature, {
        isSessionDir: true,
        defaultBranch,
        startCommit: start,
      })
    ).kind,
    "merge-base",
  );
});

test("a lost start commit falls back to HEAD; no remote falls back to local main", async (t) => {
  const repo = localRepo(t);
  const { workspaces } = await listWorkspaces(repo);
  const head = run(repo, "rev-parse", "HEAD");
  assert.deepEqual(await resolveDefaultBranch(repo), {
    name: "main",
    ref: "refs/heads/main",
  });
  assert.deepEqual(
    await workspaceBase(workspaces[0], {
      isSessionDir: true,
      defaultBranch: await resolveDefaultBranch(repo),
      startCommit: "f".repeat(40),
    }),
    { kind: "head", sha: head },
  );
  const bare = tmp(t, "ws-nobranch-");
  run(bare, "init", "-b", "trunk");
  assert.equal(await resolveDefaultBranch(bare), null);
});

test("a plain folder is no repository; more than 50 worktrees are cut", async (t) => {
  assert.equal(await listWorkspaces(tmp(t, "ws-plain-")), null);
  const repo = localRepo(t);
  for (let i = 0; i < 60; i += 1)
    run(repo, "worktree", "add", "--detach", `.worktrees/w${String(i).padStart(2, "0")}`);
  const { workspaces } = await listWorkspaces(repo);
  assert.equal(workspaces.length, MAX_WORKSPACES);
  assert.equal(workspaces[0].id, "");
});
