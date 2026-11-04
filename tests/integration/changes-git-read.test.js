import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  DIFF_BYTE_LIMIT,
  UNTRACKED_LIMIT,
  defaultBranch,
  diffStat,
  headCommit,
  readBounded,
  untrackedFiles,
  workspaceDiff,
} from "../../server/features/changes/git-read.js";
import { remoteDefaultBranch } from "../../server/features/tickets/ticket-worktree.js";
import { parseGitDiff } from "../../server/features/changes/diff-parse.js";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.test",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.test",
};
const run = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const write = (repo, name, content) => {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
const tmp = (t, prefix) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
function gitRepo(t, files, { branch = "main" } = {}) {
  const repo = path.join(tmp(t, "git-read-"), "repo");
  fs.mkdirSync(repo);
  run(repo, "init", "-b", branch);
  for (const [name, content] of Object.entries(files)) write(repo, name, content);
  run(repo, "add", ".");
  run(repo, "commit", "-m", "first");
  return repo;
}
function repoWithOrigin(t, branch, { head = branch } = {}) {
  const dir = tmp(t, "git-read-origin-");
  const origin = path.join(dir, "origin.git");
  run(dir, "init", "--bare", "-b", branch, origin);
  const repo = path.join(dir, "repo");
  run(dir, "clone", origin, repo);
  write(repo, "a.txt", "a\n");
  run(repo, "add", ".");
  run(repo, "commit", "-m", "first");
  run(repo, "push", "origin", `HEAD:${branch}`);
  run(repo, "fetch", "origin");
  run(repo, "remote", "set-head", "origin", head);
  return repo;
}

test("a working-tree diff includes staged, unstaged and untracked changes", async (t) => {
  const repo = gitRepo(t, { "a.js": "one\n" });
  const base = await headCommit(repo);
  write(repo, "a.js", "two\n");
  write(repo, "new.txt", "hello\n");
  const { text, truncated } = await workspaceDiff(repo, base);
  assert.equal(truncated, false);
  assert.deepEqual(
    parseGitDiff(text).map((f) => [f.path, f.status]),
    [
      ["a.js", "modified"],
      ["new.txt", "added"],
    ],
  );
  assert.deepEqual(await diffStat(repo, base), { files: 2, added: 2, removed: 1 });
});

test("output past the limit is cut at a line and flagged", async (t) => {
  const repo = gitRepo(t, { "a.js": "one\n" });
  const base = await headCommit(repo);
  write(repo, "big.txt", "x".repeat(100) + "\n".repeat(30000));
  const limit = 16 * 1024;
  const { text, truncated } = await workspaceDiff(repo, base, { limit });
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(text) <= limit);
  assert.ok(text.endsWith("\n"));
  assert.equal(DIFF_BYTE_LIMIT, 1048576);
});

test("readBounded rejects other exit codes", async (t) => {
  const repo = gitRepo(t, { "a.js": "one\n" });
  await assert.rejects(readBounded(repo, ["rev-parse", "--verify", "nope"]), {
    status: 409,
  });
});

test("untracked files are bounded and binaries are marked", async (t) => {
  const repo = gitRepo(t, { "a.js": "one\n" });
  const base = await headCommit(repo);
  for (let i = 0; i < 205; i++) write(repo, `out/f${i}.txt`, "a\n");
  write(repo, "img.bin", Buffer.from([0, 1, 2]));
  const listed = await untrackedFiles(repo);
  assert.equal(listed.paths.length, UNTRACKED_LIMIT);
  assert.equal(listed.more, true);
  assert.equal((await workspaceDiff(repo, base)).truncated, true);
  fs.rmSync(path.join(repo, "out"), { recursive: true });
  const { text, truncated } = await workspaceDiff(repo, base);
  assert.equal(truncated, false);
  assert.match(text, /Binary files \/dev\/null and b\/img\.bin differ/);
  assert.deepEqual(await diffStat(repo, base), { files: 1, added: 0, removed: 0 });
});

test("ignored files and external diff drivers are never used", async (t) => {
  const repo = gitRepo(t, { "a.js": "one\n", ".gitignore": "dist/\n" });
  const base = await headCommit(repo);
  const marker = path.join(path.dirname(repo), "marker");
  write(repo, ".gitattributes", "*.js diff=evil\n");
  run(repo, "config", "diff.evil.command", `touch ${marker}`);
  run(repo, "config", "diff.evil.textconv", `touch ${marker}; cat`);
  write(repo, "dist/out.js", "built\n");
  write(repo, "a.js", "two\n");
  write(repo, "b.js", "new\n");
  const { text } = await workspaceDiff(repo, base);
  assert.ok(!text.includes("dist/"));
  assert.ok(text.includes("+two"));
  assert.ok(text.includes("+new"));
  assert.equal(fs.existsSync(marker), false);
});

test("user diff prefix settings do not change the a/ b/ prefixes", async (t) => {
  const repo = gitRepo(t, { "a.js": "one\n" });
  const base = await headCommit(repo);
  run(repo, "config", "diff.noprefix", "true");
  run(repo, "config", "diff.mnemonicPrefix", "true");
  write(repo, "a.js", "two\n");
  write(repo, "new.txt", "hello\n");
  const { text } = await workspaceDiff(repo, base);
  assert.match(text, /^diff --git a\/a\.js b\/a\.js$/m);
  assert.match(text, /^diff --git a\/new\.txt b\/new\.txt$/m);
  assert.deepEqual(
    parseGitDiff(text).map((f) => f.path),
    ["a.js", "new.txt"],
  );
});

test("the remote default branch follows origin/HEAD, then main, then master", async (t) => {
  const repo = repoWithOrigin(t, "main", { head: "main" });
  run(repo, "push", "origin", "HEAD:trunk");
  run(repo, "fetch", "origin");
  run(repo, "remote", "set-head", "origin", "trunk");
  assert.equal(await remoteDefaultBranch(repo), "trunk");
  run(repo, "remote", "set-head", "-d", "origin");
  assert.equal(await remoteDefaultBranch(repo), "main");
  const onlyMaster = repoWithOrigin(t, "master");
  run(onlyMaster, "remote", "set-head", "-d", "origin");
  assert.equal(await remoteDefaultBranch(onlyMaster), "master");
  const local = gitRepo(t, { "a.js": "one\n" });
  await assert.rejects(remoteDefaultBranch(local), { status: 409 });
  assert.equal(await defaultBranch(local), "main");
  assert.equal(
    await defaultBranch(gitRepo(t, { "a.js": "x\n" }, { branch: "dev" })),
    null,
  );
});

test("no repository has no head", async (t) => {
  assert.equal(await headCommit(tmp(t, "plain-")), null);
  const empty = tmp(t, "empty-");
  run(empty, "init", "-b", "main");
  assert.equal(await headCommit(empty), null);
});
