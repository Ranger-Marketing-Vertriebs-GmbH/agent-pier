import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  diffStat,
  untrackedFiles,
  workspaceDiff,
} from "../../server/features/changes/git-read.js";
import { git } from "../../server/features/pipelines/workspace-git.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { GitRemotes } from "../../server/features/repositories/git-remote.js";
import {
  SAFE_GIT_CONFIG,
  gitCommand,
  safeGitArgs,
  safeGitEnvironment,
} from "../../server/lib/git-command.js";

const gitEnv = {
  PATH: process.env.PATH,
  HOME: os.tmpdir(),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const setup = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv });

// A repository whose own config names a program for the file-system monitor, the
// pager and the editor: each writes a marker file when git runs it.
function repository(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-git-prog-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "repo");
  fs.mkdirSync(cwd);
  const marker = path.join(root, "ran");
  const program = path.join(root, "program.sh");
  fs.writeFileSync(program, `#!/bin/sh\necho "$0 $*" >> '${marker}'\nexit 1\n`, {
    mode: 0o700,
  });
  setup(cwd, "init", "--quiet", "-b", "main");
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "one\n");
  setup(cwd, "add", ".");
  setup(cwd, "commit", "--quiet", "-m", "first");
  fs.writeFileSync(path.join(cwd, "tracked.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(cwd, "new.txt"), "new\n");
  setup(cwd, "config", "core.fsmonitor", program);
  setup(cwd, "config", "core.pager", program);
  return { cwd, marker };
}

test("the fixture's monitor program runs under a plain git call", (t) => {
  const { cwd, marker } = repository(t);
  execFileSync("git", ["status", "--porcelain"], { cwd, env: gitEnv });
  assert.equal(fs.existsSync(marker), true);
});

test("the changes reads never run a program the repository configures", async (t) => {
  const { cwd, marker } = repository(t);
  const listed = await untrackedFiles(cwd);
  assert.deepEqual(listed.paths, ["new.txt"]);
  const stat = await diffStat(cwd, "HEAD");
  assert.equal(stat.files, 2);
  assert.equal(stat.added, 2);
  const diff = await workspaceDiff(cwd, "HEAD");
  assert.match(diff.text, /\+two/);
  assert.match(diff.text, /\+new/);
  assert.equal(fs.existsSync(marker), false);
});

test("the shared git call never runs a program the repository configures", async (t) => {
  const { cwd, marker } = repository(t);
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  assert.match(status, /tracked\.txt/);
  assert.match(status, /new\.txt/);
  await git(cwd, ["diff", "--name-only"]);
  await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  await git(cwd, ["add", "--all"]);
  assert.equal(fs.existsSync(marker), false);
});

test("project scope and remote reads go through the safe options", async (t) => {
  const { cwd, marker } = repository(t);
  setup(cwd, "remote", "add", "origin", "https://example.invalid/owner/repo.git");
  const scope = await projectScope(cwd);
  assert.equal(scope.kind, "git");
  assert.equal(scope.cwd, cwd);
  assert.equal(
    await new GitRemotes().read(cwd),
    "https://example.invalid/owner/repo.git",
  );
  assert.equal(fs.existsSync(marker), false);
});

test("safe options come before the caller's arguments and survive in the environment", () => {
  const keys = SAFE_GIT_CONFIG.map(([key]) => key);
  assert.ok(keys.includes("core.fsmonitor"));
  const args = safeGitArgs(["-C", "/x", "status"]);
  assert.deepEqual(args.slice(-3), ["-C", "/x", "status"]);
  assert.equal(args[0], "-c");
  assert.ok(args.includes("core.fsmonitor=false"));
  const env = safeGitEnvironment({
    PATH: "/bin",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "x",
  });
  assert.equal(env.GIT_CONFIG_KEY_0, "credential.helper");
  assert.equal(env.GIT_CONFIG_COUNT, String(1 + SAFE_GIT_CONFIG.length));
  assert.equal(env.GIT_CONFIG_KEY_1, SAFE_GIT_CONFIG[0][0]);
  assert.equal(env.GIT_CONFIG_VALUE_1, SAFE_GIT_CONFIG[0][1]);
  assert.equal(env.PATH, "/bin");
});

test("a program reached only through the environment stays off too", (t) => {
  const { cwd, marker } = repository(t);
  execFileSync("git", ["status", "--porcelain"], {
    cwd,
    env: safeGitEnvironment(gitEnv),
  });
  assert.equal(fs.existsSync(marker), false);
});

// A hook that writes the marker, installed as `name` in the fixture repository.
function hook(cwd, marker, name) {
  const file = path.join(cwd, ".git", "hooks", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\necho ${name} >> '${marker}'\n`, { mode: 0o700 });
}

test("the fixture's index hook runs under a plain git status", (t) => {
  const { cwd, marker } = repository(t);
  setup(cwd, "config", "--unset", "core.fsmonitor");
  hook(cwd, marker, "post-index-change");
  execFileSync("git", ["status", "--porcelain"], { cwd, env: gitEnv });
  assert.match(fs.readFileSync(marker, "utf8"), /post-index-change/);
});

test("a read never runs a hook of the repository, by its folder or by core.hooksPath", async (t) => {
  const { cwd, marker } = repository(t);
  hook(cwd, marker, "post-index-change");
  const elsewhere = path.join(path.dirname(cwd), "hooks");
  fs.mkdirSync(elsewhere);
  fs.copyFileSync(
    path.join(cwd, ".git/hooks/post-index-change"),
    path.join(elsewhere, "post-index-change"),
  );
  fs.chmodSync(path.join(elsewhere, "post-index-change"), 0o700);
  const status = await git(cwd, ["status", "--porcelain", "--untracked-files=all"]);
  assert.match(status, /tracked\.txt/);
  setup(cwd, "config", "core.hooksPath", elsewhere);
  await git(cwd, ["status", "--porcelain"]);
  await diffStat(cwd, "HEAD");
  await untrackedFiles(cwd);
  assert.equal(fs.existsSync(marker), false);
});

test("an owner's action keeps the repository's hooks", async (t) => {
  const { cwd, marker } = repository(t);
  hook(cwd, marker, "pre-commit");
  await git(cwd, ["add", "--all"]);
  await git(cwd, ["commit", "--quiet", "-m", "second"], { env: gitEnv });
  assert.match(fs.readFileSync(marker, "utf8"), /pre-commit/);
});

test("which commands keep hooks is decided by the command, behind git's own options", () => {
  const off = "core.hooksPath=/dev/null";
  for (const args of [
    ["status"],
    ["-c", "core.quotePath=false", "diff", "HEAD"],
    ["-C", "/x", "rev-parse", "HEAD"],
    ["worktree", "list", "--porcelain"],
    ["worktree", "remove", "x"],
    ["some-new-command"],
  ])
    assert.ok(safeGitArgs(args).includes(off), args.join(" "));
  for (const args of [
    ["commit", "-m", "x"],
    ["-C", "/x", "fetch", "origin"],
    ["push", "origin", "HEAD"],
    ["merge", "--ff-only", "x"],
    ["worktree", "add", "x"],
  ])
    assert.equal(safeGitArgs(args).includes(off), false, args.join(" "));
  assert.equal(
    gitCommand(["--git-dir", "/x", "-c", "a=b", "remote", "get-url"]),
    "remote get-url",
  );
  assert.equal(safeGitEnvironment({}).GIT_OPTIONAL_LOCKS, "0");
  assert.equal(safeGitEnvironment({ GIT_OPTIONAL_LOCKS: "1" }).GIT_OPTIONAL_LOCKS, "1");
});
