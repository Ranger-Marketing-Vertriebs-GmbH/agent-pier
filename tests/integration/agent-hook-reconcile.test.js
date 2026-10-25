import test from "node:test";
import assert from "node:assert/strict";
import {
  body,
  done,
  event,
  hookFixture,
  makeHook,
  settle,
} from "../helpers/agent-hook-fixture.js";

// Events whose completion never comes, orphaned jobs and the run's observed steps.

test("reconcile settles stale events and removes orphaned hook jobs", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  // Received 16 minutes ago; its job is gone with a Gateway restart.
  const now = f.hooks.events.now;
  f.hooks.events.now = () => Date.now() - 16 * 60000;
  await f.hooks.deliver(hook, body('{"id":"stale"}'));
  f.hooks.events.now = now;
  const stale = event(f, hook, "stale");
  f.jobs.delete(stale.jobId);
  // A fresh event keeps its job.
  await f.hooks.deliver(hook, body('{"id":"fresh"}'));
  const fresh = event(f, hook, "fresh");
  const orphan = (id, state = {}) =>
    f.jobs.set(id, { id, declarationKey: `agentpier-hook:${id}-event`, state });
  orphan("orphan-idle");
  orphan("orphan-running", { runningAtMs: Date.now() });
  f.jobs.set("own", { id: "own", declarationKey: "agentpier-reminder:x", state: {} });

  await f.hooks.runs.reconcile();
  assert.equal(f.hooks.events.get(stale.id).status, "failed");
  assert.equal(f.hooks.events.get(fresh.id).status, "running");
  assert.deepEqual(
    [...f.jobs.keys()].sort(),
    [fresh.jobId, "orphan-running", "own"].sort(),
  );
  const listed = f.calls.filter((c) => c.method === "cron.list").at(-1).input;
  assert.equal(listed.includeDisabled, true);
  assert.equal("agentId" in listed, false);

  // Registered on the hub: every Gateway ready reconciles.
  orphan("orphan-later");
  f.assistants.gatewayEvents.ready();
  await settle();
  await settle();
  assert.equal(f.jobs.has("orphan-later"), false);
});

test("a run interrupted by a restart is failed once its window has passed", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  const timers = [];
  f.hooks.runs.later = (run, ms) => {
    timers.push({ run, ms });
    return timers.length;
  };
  // Received two minutes ago; AgentPier restarts and the Gateway becomes ready.
  let clock = Date.now() - 2 * 60000;
  f.hooks.events.now = () => clock;
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  const sessionKey = `agent:${f.runtimeAgentId}:cron:${running.jobId}:run:r1`;
  f.hooks.runs.observe({
    runId: "r1",
    sessionKey,
    stream: "item",
    data: { kind: "tool", itemId: "i1", name: "web_search", phase: "start" },
  });
  clock += 2 * 60000;
  await f.hooks.runs.reconcile();
  assert.equal(f.hooks.events.get(running.id).status, "running");
  assert.equal(f.jobs.has(running.jobId), true);
  const sweep = timers.at(-1);
  assert.ok(sweep.ms > 12 * 60000 && sweep.ms <= 14 * 60000, String(sweep.ms));

  // The completion never comes: the sweep fails it and removes its job.
  clock += sweep.ms;
  sweep.run();
  await settle();
  await settle();
  const failed = f.hooks.events.get(running.id);
  assert.equal(failed.status, "failed");
  assert.deepEqual(failed.activity, [
    { tool: "web_search", state: "running", label: "" },
  ]);
  assert.equal(f.jobs.has(running.jobId), false);
  assert.deepEqual(f.hooks.runs.steps.list(), []);
  assert.equal(f.hooks.runOrigin(f.store.getAssistant(f.id), sessionKey), null);
});

test("a completion for an agent that is gone settles the event and removes its job", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  const getAssistant = f.store.getAssistant.bind(f.store);
  f.store.getAssistant = (id) => {
    if (id === f.id) throw Object.assign(new Error("gone"), { status: 404 });
    return getAssistant(id);
  };
  await f.hooks.runs.complete(running.id, done(running.jobId));
  await settle();
  assert.equal(f.hooks.events.get(running.id).status, "failed");
  assert.equal(f.jobs.has(running.jobId), false);
  assert.equal(f.pushes.length, 0);
});

test("the run's tool steps are kept as activity without arguments", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  const sessionKey = `agent:${f.runtimeAgentId}:cron:${running.jobId}:run:r1`;
  const frame = (phase, extra = {}) => ({
    runId: "r1",
    sessionKey,
    stream: "item",
    data: {
      kind: "tool",
      itemId: "i1",
      name: "web_search",
      phase,
      meta: "query=db1 disk token=abc",
      ...extra,
    },
  });
  // Through the Gateway hub, as the agent service forwards `agent` frames.
  const emit = (payload) =>
    f.assistants.gatewayEvents.handlers.get("agent").forEach((h) => h(payload));
  emit(frame("start"));
  emit(frame("end", { status: "completed" }));
  // Another session's tool steps are not this event's.
  emit({ ...frame("start", { itemId: "i2", name: "exec" }), sessionKey: "agent:x:main" });
  assert.equal(f.hooks.events.get(running.id).sessionKey, sessionKey);
  await f.hooks.runs.complete(running.id, done(running.jobId));
  assert.deepEqual(f.hooks.events.get(running.id).activity, [
    { tool: "web_search", state: "done", label: "" },
  ]);
  assert.equal(
    JSON.stringify(f.hooks.events.get(running.id)).includes("db1 disk"),
    false,
  );
});

test("a stale job the Gateway still runs is swept at most once a minute", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  const timers = [];
  f.hooks.runs.later = (run, ms) => {
    timers.push({ run, ms });
    return timers.length;
  };
  const now = f.hooks.events.now;
  f.hooks.events.now = () => Date.now() - 20 * 60000;
  await f.hooks.deliver(hook, body('{"id":"stuck"}'));
  f.hooks.events.now = now;
  const stuck = event(f, hook, "stuck");
  f.jobs.get(stuck.jobId).state = { runningAtMs: Date.now() };
  await f.hooks.runs.reconcile();
  assert.equal(f.hooks.events.get(stuck.id).status, "running");
  assert.equal(timers.at(-1).ms, 60000);
});

test("a hook deleted while its completion is read settles without a result or notice", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f, { rights: { telegram: true } });
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  // settle() waits for the result text; the owner deletes the hook meanwhile.
  const completing = f.hooks.runs.complete(running.id, done(running.jobId));
  f.hooks.remove(f.id, hook.id);
  await completing;
  await settle();
  const tomb = f.hooks.events.get(running.id);
  assert.equal(tomb.status, "failed");
  assert.equal(tomb.hookDeleted, true);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.jobs.has(running.jobId), false);
  const conversation = f.reminders.mainConversation(f.id);
  assert.deepEqual(f.reminders.results.forConversation(conversation.id), []);
});

test("a hook paused between the endpoint and the start runs nothing", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  // The endpoint read the hook enabled; the owner pauses it before the start.
  f.hooks.update(f.id, hook.id, { revision: hook.revision, enabled: false });
  const answer = await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.equal(answer.status, 503);
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 0);
  assert.equal(event(f, hook, "p1"), null);
});

test("Gateway frames of other cron sessions or a deleted agent are ignored", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  const frame = (sessionKey) => ({
    runId: "r1",
    sessionKey,
    stream: "item",
    data: { kind: "tool", itemId: "i1", name: "exec", phase: "start" },
  });
  f.hooks.runs.observe(frame(`agent:${f.runtimeAgentId}:cron:routine-job:run:r1`));
  assert.deepEqual(f.hooks.runs.steps.list(), []);
  f.store.getAssistant = () => {
    throw Object.assign(new Error("gone"), { status: 404 });
  };
  const sessionKey = `agent:${f.runtimeAgentId}:cron:${running.jobId}:run:r1`;
  assert.doesNotThrow(() => f.hooks.runs.observe(frame(sessionKey)));
  assert.deepEqual(f.hooks.runs.steps.list(), []);
});
