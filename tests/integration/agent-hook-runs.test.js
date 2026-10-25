import test from "node:test";
import assert from "node:assert/strict";
import { ReminderWebhook } from "../../server/features/assistants/reminder-webhook.js";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import {
  body,
  deliveries,
  done,
  event,
  hookFixture,
  makeHook,
  settle,
} from "../helpers/agent-hook-fixture.js";

test("a fresh delivery starts one disabled job and forces its run", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f, { instruction: "Tell me which host." });
  const r = await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.deepEqual(r, { status: 202, body: { eventId: "p1", status: "accepted" } });
  const stored = event(f, hook, "p1");
  const adds = f.calls.filter((c) => c.method === "cron.add");
  assert.equal(adds.length, 1);
  const add = adds[0].input;
  assert.equal(add.name, "Hook Zabbix");
  assert.equal(add.declarationKey, `agentpier-hook:${stored.id}`);
  assert.equal(add.agentId, f.runtimeAgentId);
  assert.equal(add.enabled, false);
  assert.equal(add.deleteAfterRun, false);
  assert.deepEqual(add.schedule, { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" });
  assert.equal(add.wakeMode, "now");
  assert.equal(add.failureAlert, false);
  assert.equal(add.sessionTarget, "current");
  assert.equal(add.sessionKey, "session");
  assert.equal(add.payload.kind, "agentTurn");
  assert.equal(add.payload.timeoutSeconds, 300);
  assert.equal(add.payload.lightContext, false);
  assert.deepEqual(add.payload.toolsAllow, [
    "session_status",
    "memory_search",
    "memory_get",
  ]);
  assert.match(
    add.payload.message,
    /^This is the AgentPier hook "Zabbix" from "zabbix01"/,
  );
  assert.ok(add.payload.message.includes("Tell me which host."));
  assert.ok(add.payload.message.includes('{\n  "id": "p1"\n}'));
  const { url } = await f.reminders.start();
  assert.deepEqual(add.delivery, {
    mode: "announce",
    completionDestination: { mode: "webhook", to: `${url}/hook-complete/${stored.id}` },
  });
  const runs = f.calls.filter((c) => c.method === "cron.run");
  assert.deepEqual(
    runs.map((c) => c.input),
    [{ id: add.id ?? f.jobs.values().next().value.id, mode: "force" }],
  );
  assert.equal(stored.status, "running");
  assert.equal(stored.jobId, runs[0].input.id);
  assert.equal(stored.source, "local");
  assert.deepEqual(deliveries(f).at(-1).details, {
    kind: "hook-delivery",
    hookId: hook.id,
    hookEventId: stored.id,
    eventKey: "p1",
    outcome: "accepted",
    branch: "local",
    size: 11,
  });
});

test("a not-ready runtime answers 503 and records nothing", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  f.setReady(false);
  const r = await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.deepEqual(r, { status: 503, body: { eventId: "p1", status: "unavailable" } });
  assert.deepEqual(f.hooks.events.forAssistant(f.id), []);
  assert.equal(f.calls.length, 0);
  assert.equal(deliveries(f).at(-1).details.outcome, "unavailable");
  assert.equal(deliveries(f).at(-1).outcome, "failure");
});

test("a repeat answers duplicate even while the runtime is down and never runs again", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const again = await f.hooks.deliver(hook, body('{"id":"p1","n":2}'));
  assert.deepEqual(again, { status: 200, body: { eventId: "p1", status: "duplicate" } });
  f.setReady(false);
  const down = await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.deepEqual(down, { status: 200, body: { eventId: "p1", status: "duplicate" } });
  assert.equal(event(f, hook, "p1").duplicates, 2);
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 1);
  assert.deepEqual(
    deliveries(f).map((a) => a.details.outcome),
    ["accepted", "duplicate", "duplicate"],
  );
});

test("a failed cron.add answers 503 and lets the retry run", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  const call = f.assistants.runtime.client.call;
  let failing = true;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.add" && failing) {
      failing = false;
      throw Object.assign(new Error("Gateway lost"), { code: "UNAVAILABLE" });
    }
    return call(method, input);
  };
  const first = await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.deepEqual(first, {
    status: 503,
    body: { eventId: "p1", status: "unavailable" },
  });
  assert.equal(event(f, hook, "p1"), null);
  const retry = await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.deepEqual(retry, { status: 202, body: { eventId: "p1", status: "accepted" } });
  assert.equal(event(f, hook, "p1").status, "running");
  assert.equal(f.calls.filter((c) => c.method === "cron.run").length, 1);
});

test("a run OpenClaw refuses is a failed start: 503, no row, no job, retry runs", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  const call = f.assistants.runtime.client.call;
  let refusing = true;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.run" && refusing) {
      refusing = false;
      return { ok: true, ran: false };
    }
    return call(method, input);
  };
  const r = await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.deepEqual(r, { status: 503, body: { eventId: "p1", status: "unavailable" } });
  assert.equal(event(f, hook, "p1"), null);
  assert.equal(f.jobs.size, 0);
  assert.equal(deliveries(f).at(-1).details.outcome, "unavailable");
  const retry = await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.equal(retry.status, 202);
  assert.equal(event(f, hook, "p1").status, "running");
});

test("the agent's configuration is applied before the job is created", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  const order = [];
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    order.push(method);
    return call(method, input);
  };
  let failing = true;
  f.assistants.config = {
    apply: async (id) => {
      order.push(`apply:${id}`);
      if (failing) {
        failing = false;
        throw new Error("apply failed");
      }
    },
  };
  const failed = await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.equal(failed.status, 503);
  assert.equal(event(f, hook, "p1"), null);
  assert.equal(order.includes("cron.add"), false);
  order.length = 0;
  const r = await f.hooks.deliver(hook, body('{"id":"p1"}'));
  assert.equal(r.status, 202);
  assert.deepEqual(
    order.filter((m) => m !== "cron.list"),
    [`apply:${f.id}`, "cron.add", "cron.run"],
  );
});

test("a completion records a hook result, notifies only with Notify and removes the job", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f, { rights: { telegram: true } });
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const first = event(f, hook, "p1");
  // The real completion webhook route, with the reminder webhook's token.
  const { url, token } = await f.reminders.start();
  const response = await fetch(`${url}/hook-complete/${first.id}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(done(first.jobId)),
  });
  assert.equal(response.status, 204);
  await settle();
  const settled = f.hooks.events.get(first.id);
  assert.equal(settled.status, "done");
  assert.equal(settled.reply, "Disk on db1 is full; I found the log that grew.");
  assert.deepEqual(settled.notified, { push: true, telegram: true });
  assert.equal(typeof settled.completedAt, "number");
  assert.equal(f.jobs.has(first.jobId), false);
  const conversation = f.reminders.mainConversation(f.id);
  assert.deepEqual(f.pushes, [
    {
      kind: "agent-routine",
      assistantId: f.id,
      conversationId: conversation.id,
      eventId: `hook-${first.id}`,
      label: "Home",
      telegram: true,
    },
  ]);
  const outbox = f.service.outbox.all(f.channel.id).filter((e) => e.kind === "hook");
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].key, `hook:${first.id}`);
  assert.equal(outbox[0].text, "Disk on db1 is full; I found the log that grew.");
  assert.equal(outbox[0].source.hookEventId, first.id);
  assert.equal(outbox[0].source.channelId, f.channel.id);
  const [result] = f.reminders.results.forConversation(conversation.id);
  assert.equal(result.kind, "hook");
  assert.equal(result.bindingId, hook.id);
  assert.equal(result.name, "Zabbix");
  assert.equal(result.id, `${first.jobId}:1000`);
  assert.equal(result.committed, true);
  // A replayed completion changes nothing.
  await f.hooks.runs.complete(first.id, done(first.jobId));
  await settle();
  assert.equal(f.pushes.length, 1);

  // Without Notify: recorded, but no push and nothing to Telegram.
  const quiet = f.hooks.update(f.id, hook.id, {
    revision: f.hooks.store.get(hook.id).revision,
    rights: { notify: false, telegram: true },
  });
  await f.hooks.deliver(f.hooks.store.get(quiet.id), body('{"id":"p2"}'));
  const second = event(f, hook, "p2");
  await f.hooks.runs.complete(second.id, done(second.jobId, { runAtMs: 2000 }));
  await settle();
  assert.equal(f.pushes.length, 1);
  assert.equal(
    f.service.outbox.all(f.channel.id).filter((e) => e.kind === "hook").length,
    1,
  );
  assert.deepEqual(f.hooks.events.get(second.id).notified, {
    push: false,
    telegram: false,
  });
  assert.equal(f.reminders.results.forConversation(conversation.id).length, 2);
  assert.equal(f.jobs.has(second.jobId), false);
});

test("a completion of another job is refused and an unknown event is ignored", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  await assert.rejects(f.hooks.runs.complete(running.id, done("job-other")), {
    status: 403,
  });
  assert.equal(f.hooks.events.get(running.id).status, "running");
  await f.hooks.runs.complete("00000000-0000-4000-8000-000000000000", done("job-0"));
  assert.equal(f.pushes.length, 0);
});

test("overlapping completions of one event notify once", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  await Promise.all([
    f.hooks.runs.complete(running.id, done(running.jobId)),
    f.hooks.runs.complete(running.id, done(running.jobId)),
  ]);
  await settle();
  assert.equal(f.pushes.length, 1);
  assert.equal(f.hooks.events.get(running.id).status, "done");
});

test("the hook-complete route answers 404 while no hook service listens", async (t) => {
  const f = routineFixture(t);
  const webhook = new ReminderWebhook({ dataDir: f.dataDir, receive: async () => {} });
  t.after(() => webhook.close());
  const { url, token } = await webhook.start();
  const post = (route) =>
    fetch(`${url}${route}/00000000-0000-4000-8000-000000000000`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: "{}",
    });
  assert.equal((await post("/hook-complete")).status, 404);
  assert.equal((await post("/complete")).status, 204);
});

test("NO_REPLY stays silent", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f, { rights: { telegram: true } });
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  await f.hooks.runs.complete(running.id, done(running.jobId, { summary: " NO_REPLY " }));
  await settle();
  const settled = f.hooks.events.get(running.id);
  assert.equal(settled.silent, true);
  assert.equal(settled.status, "done");
  assert.equal(settled.reply, null);
  assert.equal(f.pushes.length, 0);
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
  assert.equal(f.jobs.size, 0);
});

test("a failed run sends the localized failure line instead of a reply", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f, { rights: { telegram: true } });
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  await f.hooks.runs.complete(
    running.id,
    done(running.jobId, { status: "error", summary: "model timeout" }),
  );
  await settle();
  assert.equal(f.hooks.events.get(running.id).status, "failed");
  const [entry] = f.service.outbox.all(f.channel.id);
  assert.equal(
    entry.text,
    "Der Hook Zabbix konnte nicht ausgeführt werden. Prüfe seine Ereignisse im Chat des Agenten.",
  );
  assert.equal(entry.text.includes("model timeout"), false);
  assert.equal(f.pushes.length, 1);
  const [result] = f.reminders.results.forConversation(
    f.reminders.mainConversation(f.id).id,
  );
  assert.equal(result.status, "error");
});

test("a hook's Telegram entry is sent only while the hook still delivers there", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f, { rights: { telegram: true } });
  let sends = 0;
  f.client.call = async () => ({ message_id: ++sends, chat: { id: 42 } });
  const deliverAndComplete = async (eventId, runAtMs) => {
    await f.hooks.deliver(f.hooks.store.get(hook.id), body(`{"id":"${eventId}"}`));
    const running = event(f, hook, eventId);
    await f.hooks.runs.complete(running.id, done(running.jobId, { runAtMs }));
    return f.service.outbox.all(f.channel.id).find((e) => e.key === `hook:${running.id}`);
  };
  const sent = await deliverAndComplete("p1", 1000);
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(sends, 1);
  assert.equal(f.service.outbox.get(sent.id).state, "delivered");

  // Paused after the result was queued: the entry is reviewed, never sent.
  const late = await deliverAndComplete("p2", 2000);
  f.hooks.update(f.id, hook.id, {
    revision: f.hooks.store.get(hook.id).revision,
    enabled: false,
  });
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(sends, 1);
  assert.equal(f.service.outbox.get(late.id).state, "reviewed");
});

test("the first throttled event in an hour sends one push", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f, { hourlyLimit: 1 });
  const statuses = [];
  for (const id of ["p1", "p2", "p3"])
    statuses.push((await f.hooks.deliver(hook, body(`{"id":"${id}"}`))).body.status);
  await settle();
  assert.deepEqual(statuses, ["accepted", "throttled", "throttled"]);
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 1);
  assert.equal(event(f, hook, "p3").status, "throttled");
  assert.equal(f.pushes.length, 1);
  assert.equal(f.pushes[0].kind, "agent-routine");
  assert.match(f.pushes[0].eventId, /^hook-throttled-/);
  assert.equal(f.pushes[0].assistantId, f.id);
});

test("runOrigin names the running hook event of a run session with live rights", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f, { rights: { telegram: true } });
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  const agent = f.store.getAssistant(f.id);
  const key = `agent:${f.runtimeAgentId}:cron:${running.jobId.toUpperCase()}:run:r1`;
  const origin = f.hooks.runOrigin(agent, key);
  assert.equal(origin.hook.id, hook.id);
  assert.equal(origin.event.id, running.id);
  assert.equal(origin.conversation.id, f.reminders.mainConversation(f.id).id);
  assert.equal(origin.effective.telegram, true);
  assert.equal(origin.ceiling.telegram, true);
  assert.equal(f.hooks.runOrigin(agent, `agent:other:cron:${running.jobId}`), null);
  assert.equal(f.hooks.runOrigin(agent, `agent:${f.runtimeAgentId}:main`), null);
  // The pairing gone: the live right is gone with it.
  f.service.store.disconnect(f.channel.id, f.service.store.get(f.channel.id).revision);
  assert.equal(f.hooks.runOrigin(agent, key).effective.telegram, false);
  // Settled: the session has no hook origin any more.
  await f.hooks.runs.complete(running.id, done(running.jobId));
  assert.equal(f.hooks.runOrigin(agent, key), null);
});

test("a test event runs through the same pipeline with its own event id", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  const result = await f.hooks.test(f.id, hook.id);
  assert.equal(result.status, "accepted");
  assert.match(result.eventId, /^test-[0-9a-f-]{36}$/);
  const stored = event(f, hook, result.eventId);
  assert.equal(stored.source, "test");
  assert.equal(stored.test, true);
  const payload = JSON.parse(f.hooks.events.payload(stored.id));
  assert.equal(payload.test, true);
  assert.equal(payload.message, "Test event from AgentPier");
  assert.ok(!Number.isNaN(Date.parse(payload.sentAt)));
  const message = f.calls.find((c) => c.method === "cron.add").input.payload.message;
  assert.ok(message.includes("This is a test event the owner sent from AgentPier."));
  assert.equal(deliveries(f).at(-1).details.branch, "test");
  f.hooks.update(f.id, hook.id, {
    revision: f.hooks.store.get(hook.id).revision,
    enabled: false,
  });
  await assert.rejects(f.hooks.test(f.id, hook.id), { status: 409 });
});

test("deleting a hook removes the jobs of its running events", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const running = event(f, hook, "p1");
  f.hooks.remove(f.id, hook.id);
  await settle();
  assert.equal(f.jobs.has(running.jobId), false);
  assert.equal(f.hooks.events.get(running.id), null);
});
