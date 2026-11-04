import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { SessionManager } from "../../server/features/sessions/session-manager.js";
import { headCommit } from "../../server/features/changes/git-read.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "start-commit-home-"));
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
const git = (cwd, ...args) =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const commit = (repo, name) => {
  fs.writeFileSync(path.join(repo, name), name);
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", name);
};
const launch = { command: "/bin/sh", args: ["-c", "sleep 120"], env: {} };

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ap-start-commit-"));
  const repo = path.join(dataDir, "repo");
  const plain = path.join(dataDir, "plain");
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  git(repo, "init", "-q", "-b", "main");
  commit(repo, "one");
  const manager = new SessionManager({ dataDir: path.join(dataDir, "data") });
  t.after(async () => {
    await manager.close();
    await manager.tmux(["kill-server"]).catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(manager.socketPath), { recursive: true, force: true });
  });
  let n = 0;
  const launchFixture = (options = {}) =>
    manager.create({
      id: `s${++n}`,
      name: `s${n}`,
      tool: "codex",
      accountId: "a",
      cwd: repo,
      ...launch,
      ...options,
    });
  return { manager, repo, plain, launchFixture };
}

test("a session started in a repository records HEAD", async (t) => {
  const { repo, launchFixture } = await fixture(t);
  const session = await launchFixture();
  assert.equal(session.startCommit, await headCommit(repo));
  assert.equal(session.startCommit.length, 40);
  assert.equal(session.startCommitSource, "start");
});

test("login sessions, pipeline sessions and plain folders record nothing", async (t) => {
  const { plain, launchFixture } = await fixture(t);
  const pipeline = {
    runId: "r",
    nodeId: "n",
    attemptId: "a",
    turnId: "t",
    headless: true,
  };
  for (const options of [{ purpose: "login" }, { pipeline }, { cwd: plain }]) {
    const session = await launchFixture(options);
    assert.equal(session.startCommit, undefined);
    assert.equal(session.startCommitSource, undefined);
  }
});

test("a replaced session keeps its start commit", async (t) => {
  const { manager, repo, launchFixture } = await fixture(t);
  const session = await launchFixture();
  const first = session.startCommit;
  commit(repo, "two");
  assert.notEqual(await headCommit(repo), first);
  await manager.updateReload(session.id, { state: "reloading", nativeId: "native" });
  const replaced = await manager.replace(session.id, async () => launch);
  assert.equal(replaced.startCommit, first);
  const saved = await manager.get(session.id);
  assert.equal(saved.startCommit, first);
  assert.equal(saved.startCommitSource, "start");
});

test("first-open sets a missing start commit once", async (t) => {
  const { manager, plain, launchFixture } = await fixture(t);
  const legacy = await launchFixture({ cwd: plain });
  await manager.setStartCommit(legacy.id, "a".repeat(40), "first-open");
  await manager.setStartCommit(legacy.id, "b".repeat(40), "first-open");
  const saved = await manager.get(legacy.id);
  assert.deepEqual(
    [saved.startCommit, saved.startCommitSource],
    ["a".repeat(40), "first-open"],
  );
});

test("first-open never overwrites a commit recorded at start", async (t) => {
  const { manager, launchFixture } = await fixture(t);
  const session = await launchFixture();
  const saved = await manager.setStartCommit(session.id, "c".repeat(40), "first-open");
  assert.equal(saved.startCommit, session.startCommit);
  assert.equal(saved.startCommitSource, "start");
});
