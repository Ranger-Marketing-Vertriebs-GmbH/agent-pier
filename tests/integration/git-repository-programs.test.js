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
