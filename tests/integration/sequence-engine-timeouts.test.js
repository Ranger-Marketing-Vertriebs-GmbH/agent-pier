// A launch or a delivery of the sequence engine that never answers: bounded by the
// step timeout, parked as stepTimedOut, and never holding up another repo's queue.
// Fake sessions, chat delivery and GitHub only.
import test from "node:test";
import assert from "node:assert/strict";
import { githubPull } from "../helpers/ticket-fakes.js";
import { GREEN, KEY, git, sequenceFixture } from "../helpers/sequence-fixture.js";

const OTHER = "acme/app#20";
const queueP2 = (f) =>
  f.store.append("p2", f.repoPath, [
    {
      source: "github",
      key: OTHER,
      title: "Other",
      url: "",
      kind: "session",
      options: { allowMerge: false, session: { tool: "claude", accountId: "a1" } },
    },
  ]);
const until = async (check) => {
  for (let i = 0; i < 500 && !check(); i += 1)
    await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(check());
};

test("a hung launch parks its ticket and never blocks another repo", async (t) => {
  const f = await sequenceFixture(t);
  let finish;
  const late = new Promise((resolve) => (finish = resolve));
  const launch = async (body, login, trusted) => {
    if (body.name.startsWith(KEY)) {
      await late;
      return { id: "late-session", cwd: body.cwd };
    }
    const session = {
      id: `s-${body.name.slice(0, 11)}`,
      cwd: body.cwd,
      status: "running",
    };
    f.launched.push({ body, login, trusted, session });
    return session;
  };
  const stopped = [];
  const sessions = { ...f.sessionsApi, stop: async (id) => stopped.push(id) };
  const engine = f.build({ launch, sessions, stepTimeoutMs: 300 });
  f.append([KEY]);
  queueP2(f);
  const pass = engine.run();
  // p2 starts while p1's launch still hangs.
  await until(() => f.store.queue("p2").items[0].sessionId);
  assert.equal(f.items()[0].state, "running");
  assert.equal(f.items()[0].starting, true);
  await pass;
  const [item] = f.items();
  assert.equal(item.state, "needs-owner");
  assert.equal(item.needsOwner.reason, "stepTimedOut");
  assert.ok(f.errors.some((e) => e.step === "start" && e.code === "stepTimedOut"));
  assert.ok(f.notified.length >= 1);
  // A launch that answers after all is stopped: nobody watches it.
  finish();
  await until(() => stopped.includes("late-session"));
});

test("a hung task delivery parks its ticket and stops the session", async (t) => {
  const f = await sequenceFixture(t);
  f.chatDelivery.send = () => new Promise(() => {});
  const engine = f.build({ stepTimeoutMs: 100 });
  f.append([KEY]);
  await engine.run();
  const [item] = f.items();
  assert.equal(item.needsOwner.reason, "stepTimedOut");
  assert.equal(f.launched.length, 1);
  assert.equal((await f.sessionsApi.get(item.sessionId)).status, "stopped");
});

test("one pass steps every queue even while another queue's step runs", async (t) => {
  const f = await sequenceFixture(t);
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const launch = f.engine.launch;
  const engine = f.build({
    launch: async (body, ...rest) => {
      if (body.name.startsWith(KEY)) await held;
      return launch(body, ...rest);
    },
    stepTimeoutMs: 0,
  });
  f.append([KEY]);
  engine.run();
  queueP2(f);
  // A second pass while p1 still waits: p2 starts at once, p1 is not started twice.
  engine.run();
  await until(() => f.store.queue("p2").items[0].sessionId);
  release();
  await until(() => f.items()[0].sessionId);
  assert.equal(f.launched.filter((l) => l.body.name.startsWith(KEY)).length, 1);
});

test("a repair session whose task delivery timed out is stopped and parked", async (t) => {
  const f = await sequenceFixture(t);
  const repairs = () => f.launched.filter((l) => l.body.name.endsWith("· repair"));
  const send = f.chatDelivery.send;
  f.chatDelivery.send = function (id, body) {
    if (repairs().some((l) => l.session.id === id)) return new Promise(() => {});
    return send.call(this, id, body);
  };
  const engine = f.build({ stepTimeoutMs: 100 });
  git(f.repoPath, "push", "origin", "HEAD:refs/heads/agentpier/run-1");
  const red = [{ ...GREEN[0], conclusion: "FAILURE" }];
  f.forge.pulls.push(githubPull(30, { headRef: "agentpier/run-1", contexts: red }));
  f.append([KEY], {
    kind: "pipeline",
    options: { repair: { tool: "claude", accountId: "a1" } },
  });
  await engine.run();
  const { runId } = f.items()[0];
  f.runs.set(runId, {
    id: runId,
    status: "running",
    pullRequestUrl: "https://github.com/acme/app/pull/30",
  });
  await engine.run();
  const [item] = f.items();
  assert.equal(repairs().length, 1);
  assert.equal(item.needsOwner?.reason, "stepTimedOut");
  assert.equal((await f.sessionsApi.get(repairs()[0].session.id)).status, "stopped");
});

test("a pass reports a queue that fails unexpectedly and still steps the others", async (t) => {
  const f = await sequenceFixture(t);
  const engine = f.build();
  f.append([KEY]);
  queueP2(f);
  const advance = engine.advance.bind(engine);
  engine.advance = (projectId) =>
    projectId === "p1" ? Promise.reject(new Error("broken")) : advance(projectId);
  await engine.run();
  assert.ok(f.errors.some((e) => e.step === "pass" && e.error.message === "broken"));
  assert.ok(f.store.queue("p2").items[0].sessionId);
});
