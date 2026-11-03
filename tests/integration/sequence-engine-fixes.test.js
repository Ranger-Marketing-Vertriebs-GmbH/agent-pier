import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { githubPull } from "../helpers/ticket-fakes.js";
import {
  GREEN,
  KEY,
  T0,
  awaitingMerge,
  forgeMutations as mutations,
  git,
  sequenceFixture,
} from "../helpers/sequence-fixture.js";

const MIN = 60_000;
const RED = [{ ...GREEN[0], conclusion: "FAILURE" }];
const notices = (f) => f.sent.filter((entry) => entry.text.startsWith("AgentPier:"));
const repairs = (f) => f.launched.filter((entry) => entry.body.name.endsWith("· repair"));
const passes = async (engine, count = 2) => {
  for (let n = 0; n < count; n += 1) await engine.run();
};
const idleSince = (at) => ({
  read: async () => ({ state: "idle", since: new Date(at).toISOString() }),
});

/** A pipeline ticket whose run opened PR 30 on `agentpier/run-1` (pushed to origin). */
async function pipelinePr(f, { repair, pull = {}, engine = f.engine } = {}) {
  git(f.repoPath, "push", "origin", "HEAD:refs/heads/agentpier/run-1");
  const opened = githubPull(30, { headRef: "agentpier/run-1", contexts: RED, ...pull });
  f.forge.pulls.push(opened);
  f.append([KEY, "acme/app#13"], {
    kind: "pipeline",
    options: repair ? { repair } : {},
  });
  await engine.run();
  const { runId } = f.items()[0];
  f.runs.set(runId, {
    id: runId,
    status: "running",
    pullRequestUrl: "https://github.com/acme/app/pull/30",
  });
  await engine.run();
  return opened;
}

test("session ticket gets one notice per failing sha", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f, { pull: { contexts: RED } });
  await passes(f.engine);
  assert.equal(notices(f).length, 1);
  const [first] = notices(f);
  assert.equal(first.id, f.items()[0].sessionId);
  assert.equal(first.submit, true);
  assert.match(
    first.text,
    /required checks failed on https:\/\/github\.com\/acme\/app\/pull\/30: ci\./,
  );
  assert.equal(f.items()[0].rounds.failed, 1);
  pull.headSha = "b".repeat(40);
  await passes(f.engine);
  assert.equal(notices(f).length, 2);
  assert.notEqual(notices(f)[1].deliveryId, first.deliveryId);
  assert.equal(f.items()[0].state, "awaiting-merge");
  // The third failing head is the last round: the owner decides.
  pull.headSha = "c".repeat(40);
  await passes(f.engine);
  assert.equal(notices(f).length, 2);
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.items()[0].needsOwner.reason, "failedRounds");
  assert.equal(f.notified.length, 1);
  assert.equal(f.items()[1].state, "waiting");
});

test("a review that requests changes gets one notice and no round", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f, { pull: { reviewDecision: "CHANGES_REQUESTED" } });
  await passes(f.engine);
  assert.equal(notices(f).length, 1);
  assert.match(notices(f)[0].text, /a review requested changes/);
  assert.equal(f.items()[0].rounds.failed, 0);
  pull.reviewDecision = "APPROVED";
  await passes(f.engine);
  assert.equal(notices(f).length, 1);
});

test("pipeline ticket gets a repair session in its own worktree with the configured account", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await pipelinePr(f, { repair: { tool: "codex", accountId: "a9" } });
  const [item] = f.items();
  assert.equal(item.state, "awaiting-merge");
  assert.equal(repairs(f).length, 1);
  const [{ body, trusted, session }] = repairs(f);
  assert.equal(body.tool, "codex");
  assert.equal(body.accountId, "a9");
  assert.equal(body.name, `${KEY} · repair`);
  assert.equal(trusted.ticket.key, KEY);
  assert.equal(path.dirname(body.cwd), path.join(f.repoPath, ".worktrees"));
  assert.match(path.basename(body.cwd), /^repair-12-a{7}-[a-z0-9]{1,8}$/);
  assert.equal(
    git(body.cwd, "branch", "--show-current"),
    `ticket-repair/${item.id.replace(/[^a-z0-9]/g, "").slice(0, 8)}-aaaaaaa`,
  );
  assert.equal(git(body.cwd, "rev-parse", "HEAD"), git(f.repoPath, "rev-parse", "HEAD"));
  // The source checkout stays on its branch.
  assert.equal(git(f.repoPath, "branch", "--show-current"), "main");
  assert.deepEqual(item.repair, {
    sessionId: session.id,
    cwd: body.cwd,
    sha: pull.headSha,
  });
  const tasks = f.sent.filter((entry) => entry.id === session.id);
  assert.equal(tasks.length, 1);
  assert.match(tasks[0].text, /Failed checks: ci/);
  assert.match(tasks[0].text, /git push origin HEAD:agentpier\/run-1/);
  await passes(f.engine);
  assert.equal(repairs(f).length, 1);
  // A new failing head goes to the live repair session, not to a second one.
  pull.headSha = "b".repeat(40);
  await passes(f.engine);
  assert.equal(repairs(f).length, 1);
  const later = f.sent.filter((entry) => entry.id === session.id);
  assert.equal(later.length, 2);
  assert.match(later[1].text, /^AgentPier: required checks failed/);
});

test("a restart between the repair launch and its record adopts the session", async (t) => {
  const f = await sequenceFixture(t);
  await pipelinePr(f, { repair: { tool: "claude", accountId: "a1" } });
  const [item] = f.items();
  const task = f.sent.at(-1);
  // As if the server stopped before saving the repair session and the round.
  f.store.patch("p1", item.id, {
    repair: { ...item.repair, sessionId: "" },
    rounds: { failed: 0, lastSha: null, lastReview: null, lastActionAt: null },
  });
  const engine = f.build({ restart: true });
  await passes(engine);
  assert.equal(repairs(f).length, 1);
  assert.equal(f.sent.at(-1).deliveryId, task.deliveryId);
  assert.equal(f.items()[0].repair.sessionId, item.repair.sessionId);
  assert.equal(f.items()[0].rounds.failed, 1);
});

test("repair falls back to the repo's last-used coding session", async (t) => {
  const f = await sequenceFixture(t);
  f.sessions.push(
    {
      id: "older",
      tool: "claude",
      accountId: "a5",
      cwd: f.repoPath,
      status: "stopped",
      createdAt: new Date(T0 - 60 * MIN).toISOString(),
    },
    {
      id: "newest",
      tool: "codex",
      accountId: "a7",
      launchMode: "full-auto",
      cwd: path.join(f.repoPath, "src"),
      status: "stopped",
      createdAt: new Date(T0 - MIN).toISOString(),
    },
  );
  await pipelinePr(f);
  assert.equal(repairs(f).length, 1);
  const [{ body }] = repairs(f);
  assert.equal(body.tool, "codex");
  assert.equal(body.accountId, "a7");
  assert.equal(body.launchMode, "full-auto");
});

test("a pipeline ticket without repair settings parks with repairUnconfigured", async (t) => {
  const f = await sequenceFixture(t);
  await pipelinePr(f);
  assert.equal(repairs(f).length, 0);
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.items()[0].needsOwner.reason, "repairUnconfigured");
  assert.equal(f.notified.length, 1);
  assert.equal(fs.existsSync(path.join(f.repoPath, ".worktrees")), false);
});

test("30 idle minutes with a red PR park the queue and notify", async (t) => {
  const f = await sequenceFixture(t);
  const engine = f.build({ activity: idleSince(T0) });
  await awaitingMerge(f, { engine, pull: { contexts: RED } });
  assert.equal(notices(f).length, 1);
  f.clock.now = T0 + 29 * MIN;
  await passes(engine);
  assert.equal(f.items()[0].state, "awaiting-merge");
  f.clock.now = T0 + 30 * MIN;
  await passes(engine);
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.items()[0].needsOwner.reason, "idle");
  assert.equal(f.notified.length, 1);
  assert.equal(f.notified[0].kind, "ticket-needs-owner");
  assert.equal(notices(f).length, 1);
});

test("a working session with a red PR never parks for idle", async (t) => {
  const f = await sequenceFixture(t);
  const engine = f.build({
    activity: {
      read: async () => ({ state: "working", since: new Date(T0).toISOString() }),
    },
  });
  await awaitingMerge(f, { engine, pull: { contexts: RED } });
  f.clock.now = T0 + 300 * MIN;
  await passes(engine);
  assert.equal(f.items()[0].state, "awaiting-merge");
});

test("forge failures park only after 30 minutes", async (t) => {
  const failures = {};
  const f = await sequenceFixture(t, { failures });
  await awaitingMerge(f);
  failures["POST /graphql"] = 503;
  await f.engine.run();
  assert.equal(f.items()[0].forgeFailingSince, T0);
  f.clock.now = T0 + 20 * MIN;
  await passes(f.engine);
  assert.equal(f.items()[0].state, "awaiting-merge");
  assert.equal(f.notified.length, 0);
  f.clock.now = T0 + 31 * MIN;
  await f.engine.run();
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.items()[0].needsOwner.reason, "forgeUnreachable");
  assert.equal(f.notified.length, 1);
  assert.ok(f.errors.every((entry) => !String(entry.code).includes("gh-token")));
});

test("a forge success resets the failure clock", async (t) => {
  const failures = {};
  const f = await sequenceFixture(t, { failures });
  await awaitingMerge(f);
  failures["POST /graphql"] = 503;
  await f.engine.run();
  f.clock.now = T0 + 25 * MIN;
  delete failures["POST /graphql"];
  await f.engine.run();
  assert.equal(f.items()[0].forgeFailingSince, null);
  failures["POST /graphql"] = 403;
  f.clock.now = T0 + 26 * MIN;
  await f.engine.run();
  f.clock.now = T0 + 50 * MIN;
  await f.engine.run();
  assert.equal(f.items()[0].state, "awaiting-merge");
  f.clock.now = T0 + 56 * MIN;
  await f.engine.run();
  assert.equal(f.items()[0].needsOwner.reason, "forgeUnreachable");
});

test("a merge queue that drops a red head re-arms it once a re-run is green", async (t) => {
  const f = await sequenceFixture(t, { repoSettings: { mergeQueues: ["main"] } });
  const pull = await awaitingMerge(f, { allowMerge: true });
  assert.equal(pull.inMergeQueue, true);
  pull.inMergeQueue = false;
  pull.contexts = RED;
  await passes(f.engine);
  assert.equal(f.items()[0].state, "awaiting-merge");
  assert.equal(notices(f).length, 1);
  pull.contexts = GREEN;
  await passes(f.engine);
  assert.equal(mutations(f, "enqueuePullRequest").length, 2);
  assert.equal(f.items()[0].state, "awaiting-merge");
  assert.equal(f.notified.length, 0);
});

test("an auto-merge turned off while red is not armed again after a green re-run", async (t) => {
  const f = await sequenceFixture(t);
  const pending = [{ ...GREEN[0], status: "IN_PROGRESS", conclusion: null }];
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: pending } });
  assert.equal(pull.autoMerge, true);
  pull.autoMerge = false;
  pull.contexts = RED;
  await passes(f.engine);
  assert.equal(f.items()[0].state, "awaiting-merge");
  pull.contexts = GREEN;
  await passes(f.engine);
  assert.equal(mutations(f, "enablePullRequestAutoMerge").length, 1);
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.items()[0].needsOwner.reason, "mergeDisarmed");
  assert.equal(f.notified.length, 1);
});

const FRESH = { failed: 0, lastSha: null, lastReview: null, lastActionAt: null };
const stopRepair = (f) => {
  const found = f.sessions.find((entry) => entry.id === f.items()[0].repair.sessionId);
  found.status = "stopped";
};

test("Retry on an unchanged head reuses the clean repair worktree", async (t) => {
  const f = await sequenceFixture(t);
  await pipelinePr(f, { repair: { tool: "claude", accountId: "a1" } });
  const first = f.items()[0].repair;
  stopRepair(f);
  // What Retry leaves on an open PR: fresh counters, the old repair kept.
  f.store.patch("p1", f.items()[0].id, { rounds: FRESH });
  await passes(f.engine);
  assert.equal(repairs(f).length, 2);
  assert.equal(repairs(f)[1].body.cwd, first.cwd);
  const [item] = f.items();
  assert.equal(item.state, "awaiting-merge");
  assert.equal(item.repair.cwd, first.cwd);
  assert.notEqual(item.repair.sessionId, first.sessionId);
});

test("a repair worktree with local changes is kept; the next repair gets its own", async (t) => {
  const f = await sequenceFixture(t);
  await pipelinePr(f, { repair: { tool: "claude", accountId: "a1" } });
  const first = f.items()[0].repair;
  fs.writeFileSync(path.join(first.cwd, "wip.txt"), "unfinished\n");
  stopRepair(f);
  f.store.patch("p1", f.items()[0].id, { rounds: FRESH });
  await passes(f.engine);
  assert.equal(repairs(f).length, 2);
  const second = f.items()[0].repair;
  assert.notEqual(second.cwd, first.cwd);
  assert.match(path.basename(second.cwd), /^repair-12-a{7}-2-[a-z0-9]{1,8}$/);
  assert.notEqual(
    git(second.cwd, "branch", "--show-current"),
    git(first.cwd, "branch", "--show-current"),
  );
  assert.equal(fs.readFileSync(path.join(first.cwd, "wip.txt"), "utf8"), "unfinished\n");
  assert.equal(f.items()[0].state, "awaiting-merge");
});

test("a new review on a head whose repair session ended starts another repair", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await pipelinePr(f, { repair: { tool: "claude", accountId: "a1" } });
  stopRepair(f);
  pull.reviewDecision = "CHANGES_REQUESTED";
  await passes(f.engine);
  assert.equal(repairs(f).length, 2);
  const task = f.sent.at(-1);
  assert.equal(task.id, f.items()[0].repair.sessionId);
  assert.match(task.text, /A review requested changes\./);
  assert.equal(f.items()[0].state, "awaiting-merge");
  assert.equal(f.items()[0].rounds.failed, 1);
});

test("a failed fetch of the PR branch skips the pass until the forge limit", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await pipelinePr(f, {
    repair: { tool: "claude", accountId: "a1" },
    pull: { contexts: GREEN },
  });
  git(f.repoPath, "remote", "set-url", "origin", path.join(f.root, "missing.git"));
  pull.contexts = RED;
  await passes(f.engine);
  assert.equal(repairs(f).length, 0);
  assert.equal(f.items()[0].state, "awaiting-merge");
  assert.equal(f.items()[0].forgeFailingSince, T0);
  assert.ok(f.errors.some((entry) => entry.code === "repairFetchFailed"));
  f.clock.now = T0 + 20 * MIN;
  await passes(f.engine);
  assert.equal(f.items()[0].state, "awaiting-merge");
  f.clock.now = T0 + 31 * MIN;
  await f.engine.run();
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.items()[0].needsOwner.reason, "forgeUnreachable");
  assert.equal(f.notified.length, 1);
});
