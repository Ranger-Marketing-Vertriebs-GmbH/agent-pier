import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import express from "express";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { ChatEvents } from "../../server/features/chat/chat-events.js";
import { SessionChanges } from "../../server/features/changes/session-changes.js";
import {
  CHANGES_SAMPLE_MS,
  sessionChangesTopic,
} from "../../server/features/changes/live-topics.js";
import { liveGate } from "../../server/application/live-wiring.js";
import { sessionChangesRoutes } from "../../server/http/routes/session-changes.js";
import { registerResponses } from "../../server/http/responses.js";
import { problem } from "../../server/lib/storage.js";
import { subscribe, until } from "../helpers/live-hub-subscriber.js";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "changes-home-"));
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
const write = (dir, name, content) => {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};

// An in-memory stand-in for SessionManager#get and #setStartCommit (idempotent).
function memorySessions(records) {
  return {
    get: async (id) => {
      if (!records[id]) throw problem("missing", 404);
      return { ...records[id] };
    },
    setStartCommit: async (id, sha, source) => {
      if (!records[id].startCommit)
        Object.assign(records[id], { startCommit: sha, startCommitSource: source });
      return { ...records[id] };
    },
  };
}

async function fixture(t) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ap-changes-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const repo = path.join(dir, "repo");
  const plain = path.join(dir, "plain");
  fs.mkdirSync(repo);
  fs.mkdirSync(plain);
  git(repo, "init", "-q", "-b", "main");
  write(repo, ".gitignore", ".worktrees/\n.agentpier-worktrees/\n");
  write(repo, "server/a.js", "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  const start = git(repo, "rev-parse", "HEAD");
  git(repo, "worktree", "add", "-q", "-b", "feat/x", ".worktrees/feat/x");
  git(repo, "worktree", "add", "-q", "-b", "run1", ".agentpier-worktrees/run1");
  const worktree = path.join(repo, ".worktrees/feat/x");
  write(worktree, "server/a.js", "one\ntwo\n");
  write(worktree, "notes.md", "note\n");
  const records = {
    s1: { id: "s1", cwd: repo, startCommit: start, startCommitSource: "start" },
    legacy: { id: "legacy", cwd: repo },
    plain: { id: "plain", cwd: plain },
  };
  const sessions = memorySessions(records);
  const sessionChanges = new SessionChanges({ sessions });
  const application = express();
  application.use("/api", sessionChangesRoutes({ sessionChanges }));
  registerResponses(application);
  const server = await new Promise((resolve) => {
    const listening = application.listen(0, "127.0.0.1", () => resolve(listening));
  });
  t.after(() => server.close());
  const get = async (url) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`);
    return { status: response.status, body: await response.json() };
  };
  return { get, repo, worktree, records, sessions, sessionChanges, start };
}

test("the summary lists workspaces, bases and counts; changed ones first", async (t) => {
  const { get, start } = await fixture(t);
  const { status, body } = await get("/api/sessions/s1/changes");
  assert.equal(status, 200);
  assert.equal(body.repository, true);
  assert.deepEqual(body.startCommit, { sha: start, source: "start" });
  assert.deepEqual(
    body.workspaces.map((w) => [w.id, w.branch, w.base.kind, w.files, w.added]),
    [
      [".worktrees/feat/x", "feat/x", "merge-base", 2, 2],
      ["", "main", "start-commit", 0, 0],
    ],
  );
  assert.equal(body.workspaces[0].base.sha, start);
  assert.equal(body.changedFiles, 2);
  assert.equal(JSON.stringify(body).includes(os.tmpdir()), false, "no host paths");
});

test("a legacy session gets its start commit at first open", async (t) => {
  const { get, sessions, start } = await fixture(t);
  assert.equal((await sessions.get("legacy")).startCommit, undefined);
  const body = (await get("/api/sessions/legacy/changes")).body;
  assert.deepEqual(body.startCommit, { sha: start, source: "first-open" });
  const saved = await sessions.get("legacy");
  assert.deepEqual([saved.startCommit, saved.startCommitSource], [start, "first-open"]);
  assert.equal(body.workspaces.find((w) => w.id === "").base.kind, "start-commit");
});

test("the diff of one workspace is parsed, bounded and read-only", async (t) => {
  const { get, worktree } = await fixture(t);
  const statusBefore = git(worktree, "status", "--porcelain=v1");
  const { status, body } = await get(
    "/api/sessions/s1/changes/diff?workspace=.worktrees%2Ffeat%2Fx",
  );
  assert.equal(status, 200);
  assert.equal(body.workspace, ".worktrees/feat/x");
  assert.equal(body.base.kind, "merge-base");
  assert.deepEqual(
    body.files.map((f) => f.path),
    ["server/a.js", "notes.md"],
  );
  assert.equal(body.files[0].added, 1);
  assert.equal(body.truncated, false);
  assert.equal(git(worktree, "status", "--porcelain=v1"), statusBefore);
});

test("the session directory is the empty workspace id", async (t) => {
  const { get, repo } = await fixture(t);
  write(repo, "server/a.js", "changed\n");
  const body = (await get("/api/sessions/s1/changes/diff?workspace=")).body;
  assert.deepEqual(
    [body.workspace, body.base.kind, body.files.map((f) => f.path)],
    ["", "start-commit", ["server/a.js"]],
  );
});

test("workspaces are never paths", async (t) => {
  const { get } = await fixture(t);
  for (const workspace of [
    "../outside",
    "/etc",
    ".agentpier-worktrees/run1",
    "\0",
    ".worktrees/feat/x/../../..",
    "x".repeat(400),
  ]) {
    const { status, body } = await get(
      `/api/sessions/s1/changes/diff?workspace=${encodeURIComponent(workspace)}`,
    );
    assert.equal(status, 404, workspace);
    assert.match(body.error, /Arbeitsbereich/);
  }
});

test("a missing, repeated or over-long workspace is refused", async (t) => {
  const { get } = await fixture(t);
  for (const query of ["", "?workspace=a&workspace=b", `?workspace=${"x".repeat(600)}`])
    assert.equal((await get(`/api/sessions/s1/changes/diff${query}`)).status, 400, query);
});

test("a vanished worktree is unknown", async (t) => {
  const { get, repo, worktree } = await fixture(t);
  git(repo, "worktree", "remove", "--force", worktree);
  assert.equal(
    (await get("/api/sessions/s1/changes/diff?workspace=.worktrees%2Ffeat%2Fx")).status,
    404,
  );
  const body = (await get("/api/sessions/s1/changes")).body;
  assert.deepEqual(
    body.workspaces.map((w) => w.id),
    [""],
  );
});

test("a plain folder has no workspaces", async (t) => {
  const { get, records } = await fixture(t);
  const { status, body } = await get("/api/sessions/plain/changes");
  assert.equal(status, 200);
  assert.deepEqual(body, {
    repository: false,
    startCommit: null,
    workspaces: [],
    changedFiles: 0,
  });
  assert.equal(records.plain.startCommit, undefined);
  assert.equal((await get("/api/sessions/plain/changes/diff?workspace=")).status, 404);
});

test("an unknown or invalid session is refused", async (t) => {
  const { get } = await fixture(t);
  assert.equal((await get("/api/sessions/nobody/changes")).status, 404);
  assert.equal((await get("/api/sessions/bad%20id/changes")).status, 400);
});

test("the topic samples, reads at native activity and equals the route", async (t) => {
  const { get, repo, sessionChanges } = await fixture(t);
  assert.equal(CHANGES_SAMPLE_MS, 60000);
  const chatEvents = new ChatEvents();
  const services = { sessionChanges, chatEvents };
  const hub = new LiveHub({ debounceMs: 5, maxWaitMs: 20, gate: liveGate });
  t.after(() => hub.close());
  hub.define(sessionChangesTopic(services));
  const topic = sessionChangesTopic(services);
  assert.deepEqual(
    [topic.name, topic.mode, topic.sampleMs],
    ["session.changes", "state", 60000],
  );
  assert.equal(topic.authorize({ role: "user", userId: "u" }), false);
  assert.equal(liveGate({ role: "user", userId: "u" }, "session.changes:s1"), false);

  const live = subscribe(hub, "session.changes:s1");
  const first = await live.next((frame) => frame.type === "snapshot");
  assert.deepEqual(first.data, (await get("/api/sessions/s1/changes")).body);
  assert.equal(first.data.changedFiles, 2);
  // with a 60 s sample, only native activity reads again within the test
  write(repo, "server/a.js", "changed\n");
  chatEvents.publish("s1", "native-activity");
  const nudged = await live.next((frame) => frame.data?.changedFiles === 3);
  assert.deepEqual(nudged.data, (await get("/api/sessions/s1/changes")).body);
  chatEvents.publish("s1", "message");
  live.stop();
  assert.equal(chatEvents.subscribers.size, 0);

  // a short sample sees a file write without any event
  const sampled = new LiveHub({ debounceMs: 5, maxWaitMs: 20 });
  t.after(() => sampled.close());
  sampled.define(sessionChangesTopic(services, { sampleMs: 30 }));
  const watcher = subscribe(sampled, "session.changes:s1");
  await watcher.next((frame) => frame.data?.changedFiles === 3);
  write(repo, "server/b.js", "new\n");
  await until(() => watcher.frames.some((frame) => frame.data?.changedFiles === 4));
  watcher.stop();
});
