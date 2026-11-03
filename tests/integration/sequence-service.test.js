import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { TicketSequenceService } from "../../server/features/tickets/sequence-service.js";
import { worktreeName } from "../../server/features/tickets/sequence-start.js";
import {
  KEY,
  awaitingMerge,
  git,
  forgeMutations as mutations,
  issueTicket,
  sequenceFixture,
} from "../helpers/sequence-fixture.js";

const copy = serverMessages.tickets;
const PENDING = [
  {
    __typename: "CheckRun",
    name: "ci",
    status: "IN_PROGRESS",
    conclusion: null,
    isRequired: true,
  },
];

function service(f) {
  return new TicketSequenceService({
    store: f.store,
    engine: f.engine,
    tickets: f.tickets,
    sessions: f.sessionsApi,
    worktrees: f.worktrees,
    now: () => f.clock.now,
  });
}
/** Waits until the engine holds no lock of any queue (the steps after an action). */
async function settled(f) {
  while (f.engine.locks.size)
    await Promise.all([...f.engine.locks.values()].map((lock) => lock.promise));
}
const park = (f, id, reason, extra = {}) => {
  const item = f.items().find((entry) => entry.id === id);
  if (item.state === "waiting") f.store.patch("p1", id, { state: "running" });
  return f.store.patch("p1", id, {
    state: "needs-owner",
    needsOwner: { reason, at: f.clock.now },
    ...extra,
  });
};

test("retry with an open PR watches it again with fresh counters", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  const [first] = f.items();
  assert.equal(first.armedHead, pull.headSha);
  park(f, first.id, "idle", {
    rounds: { failed: 2, lastSha: "x", lastReview: "y", lastActionAt: 5 },
    refused: { headSha: pull.headSha, what: "arm", code: "forbidden" },
    forgeFailingSince: 7,
  });
  const view = await service(f).retry("p1", first.id);
  assert.equal(view.queue.items[0].state, "awaiting-merge");
  assert.equal(view.queue.items[0].needsOwner, undefined);
  const saved = f.items()[0];
  assert.deepEqual(saved.rounds, {
    failed: 0,
    lastSha: null,
    lastReview: null,
    lastActionAt: null,
  });
  assert.equal(saved.refused, null);
  assert.equal(saved.forgeFailingSince, null);
  assert.equal(saved.pr.number, pull.number);
  await settled(f);
  // The engine stepped right after the retry and found the PR still armed.
  assert.equal(f.items()[0].armedHead, pull.headSha);
  assert.equal(mutations(f, "enablePullRequestAutoMerge").length, 1);
});

test("retry with a closed PR starts afresh on a new branch from the default branch", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f);
  const [first] = f.items();
  // The closed attempt left a commit; main moved on meanwhile.
  fs.writeFileSync(path.join(first.worktree.cwd, "attempt.txt"), "one\n");
  git(first.worktree.cwd, "add", ".");
  git(first.worktree.cwd, "commit", "-m", "attempt");
  fs.writeFileSync(path.join(f.root, "seed", "b.txt"), "b\n");
  git(path.join(f.root, "seed"), "add", ".");
  git(path.join(f.root, "seed"), "commit", "-m", "second");
  git(path.join(f.root, "seed"), "push", "origin", "HEAD:main");
  const main = git(path.join(f.root, "seed"), "rev-parse", "HEAD");
  pull.state = "CLOSED";
  await f.engine.run();
  assert.equal(f.items()[0].needsOwner.reason, "prClosed");
  await service(f).retry("p1", first.id);
  await settled(f);
  const [item] = f.items();
  assert.equal(f.launched.length, 2);
  assert.equal(item.state, "running");
  assert.equal(item.pr, undefined);
  assert.equal(item.attempt, 2);
  assert.equal(item.sessionId, f.launched[1].session.id);
  assert.notEqual(item.worktree.cwd, first.worktree.cwd);
  assert.equal(f.launched[1].body.cwd, item.worktree.cwd);
  assert.equal(item.worktree.branch, `${first.worktree.branch}-2`);
  assert.equal(git(item.worktree.cwd, "rev-parse", "HEAD"), main);
  // The closed attempt's folder and commit stay for the owner.
  assert.equal(fs.existsSync(path.join(first.worktree.cwd, "attempt.txt")), true);
  assert.equal(
    git(first.worktree.cwd, "symbolic-ref", "--short", "HEAD"),
    first.worktree.branch,
  );
  assert.equal(f.sent.length, 2);
  assert.ok(f.sent[1].text.includes(item.worktree.branch));
});

test("retry refuses a leftover worktree with local changes", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY]);
  await f.engine.run();
  const [first] = f.items();
  f.sessions[0].status = "stopped";
  await f.engine.run();
  assert.equal(f.items()[0].needsOwner.reason, "noPullRequest");
  fs.writeFileSync(path.join(first.worktree.cwd, "notes.txt"), "draft\n");
  await assert.rejects(service(f).retry("p1", first.id), {
    status: 409,
    message: copy.worktreeLeftover,
  });
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.launched.length, 1);
});

test("retry after an interrupted start reuses its clean worktree, never a foreign one", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY, "acme/app#13"]);
  const [first, second] = f.items();
  const tree = await f.worktrees.createSession({
    projectPath: f.repoPath,
    ticket: issueTicket(KEY),
    name: worktreeName(first),
  });
  f.store.patch("p1", first.id, {
    state: "running",
    starting: true,
    worktree: { cwd: tree.cwd, branch: tree.branch, baseRef: "main" },
  });
  await f.engine.run();
  assert.equal(f.items()[0].needsOwner.reason, "startInterrupted");
  assert.equal(f.launched.length, 0);
  await service(f).retry("p1", first.id);
  await settled(f);
  assert.equal(f.launched.length, 1);
  assert.equal(f.launched[0].body.cwd, tree.cwd);
  assert.equal(f.items()[0].worktree.branch, tree.branch);
  // A folder with the item's name whose worktree was never saved is not reused.
  await f.worktrees.createSession({
    projectPath: f.repoPath,
    ticket: issueTicket("acme/app#13"),
    name: worktreeName(second),
  });
  park(f, second.id, "startInterrupted");
  await assert.rejects(service(f).retry("p1", second.id), {
    status: 409,
    message: copy.worktreeLeftover,
  });
});

test("retry of a failed pipeline run queues a new run", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY], { kind: "pipeline" });
  await f.engine.run();
  const runId = f.items()[0].runId;
  f.queued.get(runId).state = "failed";
  await f.engine.run();
  assert.equal(f.items()[0].needsOwner.reason, "runFailed");
  await service(f).retry("p1", f.items()[0].id);
  await settled(f);
  const [item] = f.items();
  assert.equal(item.state, "running");
  assert.notEqual(item.runId, runId);
  assert.equal(f.queued.size, 2);
});

test("mark done moves on without writing to the tracker", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY, "acme/app#13"]);
  await f.engine.run();
  const [first] = f.items();
  park(f, first.id, "idle");
  const before = f.sourceCalls.length;
  const view = await service(f).markDone("p1", first.id);
  assert.equal(view.queue.items[0].state, "done");
  assert.equal(view.queue.items[0].doneBy, "owner");
  await settled(f);
  assert.equal(f.launched.length, 2);
  assert.deepEqual(
    f.sourceCalls
      .slice(before)
      .filter((call) => call.name !== "get" && call.name !== "markInProgress"),
    [],
  );
  assert.equal(
    f.sourceCalls.some((call) => call.name === "markDone"),
    false,
  );
});

test("remove of a parked armed PR turns auto-merge off", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  assert.equal(pull.autoMerge, true);
  const [first] = f.items();
  park(f, first.id, "idle");
  const view = await service(f).remove("p1", first.id);
  assert.equal(pull.autoMerge, false);
  assert.equal(mutations(f, "disablePullRequestAutoMerge").length, 1);
  assert.deepEqual(
    view.queue.items.map((item) => item.key),
    ["acme/app#13"],
  );
});

test("mark done of a parked armed PR turns auto-merge off", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  assert.equal(pull.autoMerge, true);
  const [first] = f.items();
  park(f, first.id, "idle");
  const view = await service(f).markDone("p1", first.id);
  assert.equal(view.queue.items[0].state, "done");
  assert.equal(pull.autoMerge, false);
  assert.equal(mutations(f, "disablePullRequestAutoMerge").length, 1);
  assert.equal(
    f.sourceCalls.some((call) => call.name === "markDone"),
    false,
  );
});

test("mark done of a PR merged by hand needs no disarm", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  const [first] = f.items();
  park(f, first.id, "idle");
  pull.state = "MERGED";
  pull.autoMerge = false;
  await service(f).markDone("p1", first.id);
  assert.equal(f.items()[0].state, "done");
  assert.equal(mutations(f, "disablePullRequestAutoMerge").length, 0);
});

test("mark done and remove of an armed PR are refused while GitHub is unreachable", async (t) => {
  const failures = {};
  const f = await sequenceFixture(t, { failures });
  await awaitingMerge(f, { allowMerge: true, pull: { contexts: PENDING } });
  const [first] = f.items();
  park(f, first.id, "idle");
  failures["POST /graphql"] = 503;
  for (const action of ["markDone", "remove"])
    await assert.rejects(service(f)[action]("p1", first.id), { status: 502 });
  assert.equal(f.items()[0].state, "needs-owner");
});

test("the view lists sessions for the repair defaults at most once a minute", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY]);
  let lists = 0;
  const sessions = {
    list: async () => {
      lists += 1;
      return f.sessionsApi.list();
    },
  };
  const owner = new TicketSequenceService({
    store: f.store,
    engine: f.engine,
    tickets: f.tickets,
    sessions,
    worktrees: f.worktrees,
    now: () => f.clock.now,
  });
  f.sessions.push({
    id: "s-old",
    tool: "claude",
    accountId: "a9",
    cwd: f.repoPath,
    status: "running",
    createdAt: new Date(f.clock.now).toISOString(),
  });
  const first = await owner.view("p1");
  assert.deepEqual(first.defaults.repair, { tool: "claude", accountId: "a9" });
  await owner.view("p1");
  f.clock.now += 59_000;
  await owner.view("p1");
  assert.equal(lists, 1);
  f.clock.now += 2_000;
  await owner.view("p1");
  assert.equal(lists, 2);
});

test("owner actions wait for a running step and step the queue after them", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY]);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const steps = [];
  t.mock.method(f.engine, "steps", async () => {
    steps.push(steps.length);
    if (steps.length === 1) await gate;
  });
  const running = f.engine.nudge("p1");
  const order = [];
  const action = f.engine.exclusive("p1", async () => {
    order.push("action");
    return 7;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, []);
  release();
  await running;
  assert.equal(await action, 7);
  await settled(f);
  assert.deepEqual(order, ["action"]);
  assert.equal(steps.length, 2);
  // A refused action changes nothing and leaves the queue as it was.
  await assert.rejects(
    f.engine.exclusive("p1", async () => {
      throw new Error("refused");
    }),
    /refused/,
  );
  await settled(f);
  assert.equal(steps.length, 2);
});

test("an owner action waits for one step, not the whole step loop", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY]);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const order = [];
  t.mock.method(f.engine, "step", async () => {
    order.push("step");
    if (order.length === 1) await gate;
    return true;
  });
  const running = f.engine.nudge("p1");
  await new Promise((resolve) => setImmediate(resolve));
  const action = f.engine.exclusive("p1", async () => order.push("action"));
  release();
  await action;
  await running;
  // The loop stopped after its running step; the action's own steps came after it.
  assert.deepEqual(order.slice(0, 2), ["step", "action"]);
  await settled(f);
  assert.ok(order.filter((entry) => entry === "step").length > 2);
});

test("retry of a live session without a PR watches it again, never launches twice", async (t) => {
  const f = await sequenceFixture(t);
  const engine = f.build({
    activity: { read: async () => ({ state: "working", since: null }) },
  });
  f.append([KEY]);
  await engine.run();
  f.clock.now += 7 * 3_600_000;
  await engine.run();
  const [first] = f.items();
  assert.equal(first.needsOwner.reason, "noPullRequest");
  const owner = new TicketSequenceService({
    store: f.store,
    engine,
    tickets: f.tickets,
    sessions: f.sessionsApi,
    worktrees: f.worktrees,
    now: () => f.clock.now,
  });
  const view = await owner.retry("p1", first.id);
  assert.equal(view.queue.items[0].state, "running");
  while (engine.locks.size)
    await Promise.all([...engine.locks.values()].map((lock) => lock.promise));
  const [item] = f.items();
  assert.equal(f.launched.length, 1);
  assert.equal(item.sessionId, first.sessionId);
  assert.equal(item.starting, undefined);
  assert.equal(item.watchSince, f.clock.now);
  assert.equal(item.state, "running");
  // The resumed watch has its own clock.
  f.clock.now += 3_600_000;
  await engine.run();
  assert.equal(f.items()[0].state, "running");
});
