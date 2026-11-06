import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { githubPull } from "../helpers/ticket-fakes.js";
import {
  GREEN,
  KEY,
  awaitingMerge,
  forgeMerges as merges,
  sequenceFixture,
  T0,
} from "../helpers/sequence-fixture.js";

async function assertParked(f, reason) {
  const [first, second] = f.items();
  assert.equal(first.state, "needs-owner");
  assert.equal(first.needsOwner.reason, reason);
  assert.equal(f.notified.length, 1);
  assert.equal(f.notified[0].kind, "ticket-needs-owner");
  assert.equal(f.notified[0].projectId, "p1");
  assert.match(f.notified[0].eventId, /^[0-9a-f]{64}$/);
  await f.engine.run();
  await f.engine.run();
  assert.equal(f.notified.length, 1);
  assert.equal(second.state, "waiting");
  assert.equal(f.items()[1].state, "waiting");
}

test("closed PR parks the queue and notifies once", async (t) => {
  const f = await sequenceFixture(t);
  const pull = await awaitingMerge(f);
  pull.state = "CLOSED";
  await f.engine.run();
  await assertParked(f, "prClosed");
});

test("failed run parks the queue and notifies once", async (t) => {
  for (const status of ["failed", "cancelled"]) {
    const f = await sequenceFixture(t);
    f.append([KEY, "acme/app#13"], { kind: "pipeline" });
    await f.engine.run();
    const { runId } = f.items()[0];
    f.runs.set(runId, { id: runId, status, pullRequestUrl: null });
    await f.engine.run();
    await assertParked(f, "runFailed");
  }
});

test("a failed queue start parks with runFailed", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY, "acme/app#13"], { kind: "pipeline" });
  await f.engine.run();
  f.queued.get(f.items()[0].runId).state = "failed";
  await f.engine.run();
  await assertParked(f, "runFailed");
});

test("a session that stopped without a PR parks the queue and notifies once", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY, "acme/app#13"]);
  await f.engine.run();
  f.sessions[0].status = "stopped";
  await f.engine.run();
  await assertParked(f, "noPullRequest");
});

test("a session that is gone parks with sessionEnded", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY, "acme/app#13"]);
  await f.engine.run();
  f.sessions.length = 0;
  await f.engine.run();
  await assertParked(f, "sessionEnded");
});

test("a project without GitHub access parks with githubRequired", async (t) => {
  const f = await sequenceFixture(t);
  f.tickets.repositories.token = () => null;
  f.append([KEY, "acme/app#13"]);
  await f.engine.run();
  await assertParked(f, "githubRequired");
  assert.equal(f.launched.length, 0);
});

test("an undelivered task stops the session and parks", async (t) => {
  const f = await sequenceFixture(t);
  f.chatDelivery.deliver = () => ({ status: "rejected" });
  f.append([KEY, "acme/app#13"]);
  await f.engine.run();
  assert.equal(f.sessions[0].status, "stopped");
  await assertParked(f, "taskNotDelivered");
});

test("a hook-blocked task parks like an undelivered one", async (t) => {
  const f = await sequenceFixture(t);
  f.chatDelivery.deliver = () => ({ status: "rejected", reason: "CHAT_HOOK_BLOCKED" });
  f.append([KEY, "acme/app#13"]);
  await f.engine.run();
  assert.equal(f.sessions[0].status, "stopped");
  await assertParked(f, "taskNotDelivered");
});

test("a hook block after the hand-off parks the start", async (t) => {
  const f = await sequenceFixture(t);
  f.chatDelivery.deliver = () => ({
    status: "handed-off",
    deliveryId: "d1",
    confirmation: "events",
  });
  f.chatDelivery.settled = async () => ({
    status: "rejected",
    reason: "CHAT_HOOK_BLOCKED",
  });
  f.append([KEY, "acme/app#13"]);
  await f.engine.run();
  assert.equal(f.sessions[0].status, "stopped");
  await assertParked(f, "taskNotDelivered");
});

test("an accepted task starts the ticket", async (t) => {
  const f = await sequenceFixture(t);
  f.chatDelivery.deliver = () => ({ status: "accepted" });
  f.append([KEY, "acme/app#13"]);
  await f.engine.run();
  assert.equal(f.items()[0].state, "running");
  assert.notEqual(f.sessions[0].status, "stopped");
});

test("a source blip skips the pass without parking", async (t) => {
  let failing = true;
  const f = await sequenceFixture(t, {
    getError: () =>
      failing ? Object.assign(new Error("x"), { code: "unavailable" }) : null,
  });
  f.append([KEY]);
  await f.engine.run();
  assert.equal(f.items()[0].state, "waiting");
  assert.equal(f.launched.length, 0);
  failing = false;
  await f.engine.run();
  assert.equal(f.items()[0].state, "running");
});

test("a forge read failure skips the pass without parking", async (t) => {
  const f = await sequenceFixture(t, { failures: { "POST /graphql": 503 } });
  f.append([KEY]);
  await f.engine.run();
  const branch = f.items()[0].worktree.branch;
  f.forge.pulls.push(githubPull(30, { headRef: branch }));
  await f.engine.run();
  await f.engine.run();
  assert.equal(f.items()[0].state, "awaiting-merge");
  assert.equal(f.notified.length, 0);
});

test("restart resumes watching", async (t) => {
  const f = await sequenceFixture(t, { repoSettings: { autoMergeAllowed: false } });
  const pending = [{ ...GREEN[0], status: "IN_PROGRESS", conclusion: null }];
  const pull = await awaitingMerge(f, { allowMerge: true, pull: { contexts: pending } });
  await f.engine.close();
  assert.equal(merges(f).length, 0);
  // The checks turned green while the server was down: the new engine merges.
  pull.contexts = GREEN;
  const engine = f.build({ restart: true });
  await engine.run();
  assert.equal(merges(f).length, 1);
  assert.equal(pull.state, "MERGED");
  assert.equal(f.items()[0].state, "done");
  assert.equal(f.launched.length, 2);
});

function interruptedSession(f) {
  f.append([KEY]);
  const [item] = f.items();
  const cwd = path.join(f.repoPath, ".worktrees", "ticket-12-abcdefgh");
  f.store.patch("p1", item.id, {
    state: "running",
    starting: true,
    startedAt: T0,
    worktree: { cwd, branch: "ticket/12-fix-thing-12", baseRef: "main" },
  });
  return { item, cwd };
}

test("restart adopts a session launched before the item was saved", async (t) => {
  const f = await sequenceFixture(t);
  const { cwd } = interruptedSession(f);
  f.sessions.push(
    {
      id: "other",
      cwd,
      status: "running",
      tool: "claude",
      createdAt: "x",
      ticket: { key: "acme/app#99" },
    },
    {
      id: "s-adopted",
      cwd,
      status: "running",
      tool: "claude",
      accountId: "a1",
      createdAt: "x",
      ticket: { key: KEY },
    },
  );
  const engine = f.build({ restart: true });
  await engine.run();
  assert.equal(f.launched.length, 0);
  const [item] = f.items();
  assert.equal(item.sessionId, "s-adopted");
  assert.equal(item.starting, undefined);
  assert.equal(item.state, "running");
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].id, "s-adopted");
  assert.equal(f.ticketStore.starts("p1").length, 1);
  // A second restart delivers with the same id and writes no second start record.
  const again = f.build({ restart: true });
  f.store.patch("p1", item.id, { starting: true });
  await again.run();
  assert.equal(f.sent[1].deliveryId, f.sent[0].deliveryId);
  assert.equal(f.ticketStore.starts("p1").length, 1);
  assert.equal(f.sourceCalls.filter((call) => call.name === "markInProgress").length, 1);
});

test("restart without a matching session parks with startInterrupted and launches nothing", async (t) => {
  const f = await sequenceFixture(t);
  interruptedSession(f);
  const engine = f.build({ restart: true });
  await engine.run();
  assert.equal(f.launched.length, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.items()[0].needsOwner.reason, "startInterrupted");
  assert.equal(f.notified.length, 1);
});

test("restart of a pipeline start re-adds nothing that the queue has", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY], { kind: "pipeline" });
  await f.engine.run();
  const [item] = f.items();
  f.store.patch("p1", item.id, { starting: true });
  const engine = f.build({ restart: true });
  await engine.run();
  assert.equal(f.queued.size, 1);
  assert.equal(f.items()[0].starting, undefined);
  assert.equal(f.items()[0].state, "running");
  // Reserved but never added (crash before add): the same id is queued once.
  f.queued.clear();
  f.store.patch("p1", item.id, { starting: true });
  await f.build({ restart: true }).run();
  assert.deepEqual([...f.queued.keys()], [item.runId]);
});

test("a manual start of the same ticket elsewhere is not blocked", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY]);
  await f.engine.run();
  const result = await f.tickets.start("p1", {
    source: "github",
    key: KEY,
    kind: "session",
    again: true,
    session: { tool: "claude", accountId: "a1" },
  });
  assert.ok(result.session.id);
  assert.equal(result.session.id !== f.items()[0].sessionId, true);
  await f.engine.run();
  assert.equal(f.items()[0].state, "running");
});

test("nudges coalesce and runChanged nudges the queue of the run", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY], { kind: "pipeline" });
  await Promise.all([f.engine.nudge("p1"), f.engine.nudge("p1"), f.engine.run()]);
  assert.equal(f.queued.size, 1);
  const { runId } = f.items()[0];
  f.runs.set(runId, { id: runId, status: "failed" });
  f.engine.runChanged({ id: "unrelated" });
  assert.equal(f.items()[0].state, "running");
  f.engine.runChanged({ id: runId });
  await f.engine.advance("p1");
  assert.equal(f.items()[0].state, "needs-owner");
});

test("start runs a first pass on its timer and close stops it", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY]);
  const engine = f.build({ intervalMs: 60_000, initialDelayMs: 0 });
  engine.start();
  for (let n = 0; n < 200 && f.items()[0].state === "waiting"; n += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  await engine.run();
  assert.equal(f.items()[0].state, "running");
  await engine.close();
  assert.equal(engine.interval, null);
});

test("close aborts a pending forge read and resolves within 1 s", async (t) => {
  const f = await sequenceFixture(t);
  await awaitingMerge(f);
  const hanging = [];
  f.tickets.fetchImpl = (url, init) => {
    if (!String(url).includes("graphql")) return f.forge.fetchImpl(url, init);
    hanging.push(url);
    return new Promise((_resolve, reject) =>
      init.signal.addEventListener("abort", () => reject(init.signal.reason)),
    );
  };
  const pass = f.engine.run();
  for (let n = 0; n < 200 && hanging.length === 0; n += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(hanging.length, 1);
  const started = Date.now();
  await f.engine.close();
  assert.ok(Date.now() - started < 1000);
  await pass;
  assert.equal(f.items()[0].state, "awaiting-merge");
});

test("a resumed pipeline start skips outages but parks other failures", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY], { kind: "pipeline" });
  const [item] = f.items();
  f.store.patch("p1", item.id, {
    state: "running",
    starting: true,
    startedAt: T0,
    runId: "11111111-1111-4111-8111-111111111111",
  });
  const add = f.runQueue.add;
  f.runQueue.add = () => {
    throw Object.assign(new Error("closed"), { status: 503 });
  };
  const engine = f.build({ restart: true });
  await engine.run();
  assert.equal(f.items()[0].state, "running");
  assert.equal(f.items()[0].starting, true);
  f.pipelines.get = async () => {
    throw new TypeError("broken");
  };
  f.runQueue.add = add;
  await engine.run();
  assert.equal(f.items()[0].state, "needs-owner");
  assert.equal(f.items()[0].needsOwner.reason, "startFailed");
  assert.equal(f.notified.length, 1);
});

test("a failing nudge from runChanged is reported, not left unhandled", async (t) => {
  const f = await sequenceFixture(t);
  f.append([KEY], { kind: "pipeline" });
  await f.engine.run();
  const { runId } = f.items()[0];
  f.engine.steps = async () => {
    throw new Error("boom");
  };
  f.engine.runChanged({ id: runId });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(f.errors.some((entry) => entry.step === "nudge"));
});
