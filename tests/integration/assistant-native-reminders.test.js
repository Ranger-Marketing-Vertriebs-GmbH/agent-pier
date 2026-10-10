import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { NativeReminders } from "../../server/features/assistants/native-reminders.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";
function setup(t, options) {
  const f = channelFixture(t, options),
    id = f.channel.assistantId,
    jobs = new Map(),
    calls = [];
  f.store.updateAssistant(id, { capabilities: { memory: false, reminders: true } }, 1);
  f.assistants.admit = (fn) => fn();
  f.assistants.requireReady = () => {};
  f.assistants.config = { apply: async () => {} };
  f.assistants.runtime.client.call = async (method, input) => {
    calls.push({ method, input });
    if (method === "cron.list")
      return {
        jobs: [...jobs.values()].filter((j) => j.agentId === input.agentId),
        hasMore: false,
      };
    if (method === "cron.add") {
      const job = { ...input, id: `job-${jobs.size}`, updatedAtMs: 1, state: {} };
      jobs.set(job.id, job);
      return { created: true, job };
    }
    if (method === "cron.update") {
      const j = { ...jobs.get(input.id), ...input.patch, updatedAtMs: 2 };
      jobs.set(j.id, j);
      return j;
    }
    if (method === "cron.remove") {
      jobs.delete(input.id);
      return { removed: true };
    }
    if (method === "cron.runs")
      return {
        entries: [
          {
            runAtMs: 123,
            status: "ok",
            completionStatus: "succeeded",
            deliveryStatus: "delivered",
            error: "private-token",
          },
        ],
      };
    assert.fail(method);
  };
  const reminders = new NativeReminders({
    assistants: f.assistants,
    channels: f.service,
    dataDir: f.dataDir,
  });
  f.assistants.reminders = reminders;
  t.after(() => reminders.close());
  const input = {
    clientRequestId: "create-1",
    name: "Shopping",
    message: "Buy bread",
    schedule: { kind: "at", at: new Date(Date.now() + 60000).toISOString() },
  };
  return { ...f, id, jobs, calls, reminders, input };
}
test("native reminder creation owns only delivery binding and repeats the same operation without another job", async (t) => {
  const f = setup(t);
  const first = await f.reminders.create(f.id, f.input);
  const again = await f.reminders.create(f.id, f.input);
  assert.equal(first.id, again.id);
  assert.equal(f.jobs.size, 1);
  const job = [...f.jobs.values()][0];
  assert.equal(job.agentId, f.store.getAssistant(f.id).runtimeAgentId);
  assert.deepEqual(job.payload.toolsAllow, []);
  assert.equal(job.delivery.mode, "webhook");
  assert.equal(job.schedule.kind, "at");
  assert.ok(!JSON.stringify(first).includes("http://"));
  assert.ok(!JSON.stringify(first).includes(f.reminders.webhook.connection.token));
  await assert.rejects(f.reminders.create(f.id, { ...f.input, message: "Different" }), {
    status: 409,
  });
});
test("unknown native creation reconciles by declaration identity without replay", async (t) => {
  const f = setup(t),
    call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, args) => {
    const result = await call(method, args);
    if (method === "cron.add") throw Object.assign(Error(), { code: "CLOSED" });
    return result;
  };
  await assert.rejects(f.reminders.create(f.id, f.input), { status: 503 });
  const result = await f.reminders.create(f.id, f.input);
  assert.equal(result.status, "ready");
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 1);
});
test("native completion hands off durably and a duplicate never sends twice", async (t) => {
  const f = setup(t),
    reminder = await f.reminders.create(f.id, f.input);
  const job = [...f.jobs.values()][0];
  const event = { jobId: job.id, runAtMs: 123, status: "ok", summary: "Buy bread" };
  const url = `${f.reminders.webhook.connection.url}/complete/${reminder.id}`;
  const send = (token, body = event) =>
    fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  assert.equal((await send("wrong")).status, 401);
  assert.equal(
    (await send(f.reminders.webhook.connection.token, { ...event, jobId: "foreign" }))
      .status,
    403,
  );
  assert.equal((await send(f.reminders.webhook.connection.token)).status, 204);
  assert.equal((await send(f.reminders.webhook.connection.token)).status, 204);
  assert.equal(f.service.outbox.all(f.channel.id).length, 1);
  let sends = 0;
  f.client.call = async () => ({ message_id: ++sends, chat: { id: 42 } });
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(sends, 1);
  const history = await f.reminders.runs(f.id, reminder.id);
  assert.ok(!JSON.stringify(history).includes("private-token"));
});
test("changed pairing never redirects a reminder and revocation blocks queued output", async (t) => {
  const f = setup(t),
    reminder = await f.reminders.create(f.id, f.input),
    job = [...f.jobs.values()][0];
  await f.reminders.complete(reminder.id, {
    jobId: job.id,
    runAtMs: 123,
    status: "ok",
    summary: "Buy bread",
  });
  const channel = f.service.store.get(f.channel.id);
  f.service.store.write({ ...channel, chatId: "43", userId: "43" }, channel.revision);
  f.client.call = () => assert.fail("must not send to new owner");
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(
    f.service.outbox.all(f.channel.id)[0].diagnostic,
    "CHANNEL_DESTINATION_CHANGED",
  );
  await f.reminders.remove(f.id, reminder.id);
  assert.equal(f.jobs.size, 0);
  await f.reminders.complete(reminder.id, {
    jobId: job.id,
    runAtMs: 124,
    status: "ok",
    summary: "Late",
  });
  assert.equal(f.service.outbox.all(f.channel.id).length, 1);
});
test("chat reminders retain trusted Telegram source and foreign agents cannot mutate them", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.reminders.create(f.id, f.input, {
      kind: "telegram",
      channelId: f.channel.id,
      chatId: "99",
      userId: "99",
    }),
    { status: 403 },
  );
  const reminder = await f.reminders.create(f.id, f.input);
  const other = f.store.createAssistant({
    name: "Other",
    model: { connectionId: "test", modelId: "fixture" },
    capabilities: { memory: false, reminders: true },
  });
  await assert.rejects(f.reminders.remove(other.id, reminder.id), { status: 404 });
  await f.reminders.update(f.id, reminder.id, {
    enabled: false,
    revision: reminder.revision,
  });
  assert.equal([...f.jobs.values()][0].enabled, false);
  await assert.rejects(
    f.reminders.update(f.id, reminder.id, { enabled: true, revision: reminder.revision }),
    { status: 409 },
  );
});

test("uncertain removal stays visible for recovery and revokes late delivery", async (t) => {
  const f = setup(t),
    reminder = await f.reminders.create(f.id, f.input),
    job = [...f.jobs.values()][0];
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, args) => {
    if (method === "cron.remove") throw Object.assign(Error(), { code: "CLOSED" });
    return call(method, args);
  };
  await assert.rejects(f.reminders.remove(f.id, reminder.id));
  const list = await f.reminders.list(f.id);
  assert.equal(list.reminders.length, 1);
  assert.equal(list.reminders[0].status, "unknown");
  await f.reminders.complete(reminder.id, {
    jobId: job.id,
    runAtMs: 123,
    status: "ok",
    summary: "Late",
  });
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
  f.assistants.runtime.client.call = call;
  await f.reminders.remove(f.id, reminder.id);
  assert.equal((await f.reminders.list(f.id)).reminders.length, 0);
});
test("native job projections omit unknown schedule fields and API delivery secrets", async (t) => {
  const f = setup(t);
  await f.reminders.create(f.id, f.input);
  const job = [...f.jobs.values()][0];
  job.schedule.hostSecret = "must-not-leak";
  const list = await f.reminders.list(f.id);
  assert.ok(!JSON.stringify(list).includes("must-not-leak"));
  assert.ok(!JSON.stringify(list).includes("http://"));
});

test("completion reconciliation cannot resurrect a concurrently removed reminder", async (t) => {
  const f = setup(t),
    call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, args) => {
    const result = await call(method, args);
    if (method === "cron.add") throw Object.assign(Error(), { code: "CLOSED" });
    return result;
  };
  await assert.rejects(f.reminders.create(f.id, f.input));
  const binding = f.reminders.bindings.list(f.id)[0],
    job = [...f.jobs.values()][0];
  let release, reached;
  const waiting = new Promise((r) => {
    reached = r;
  });
  f.assistants.runtime.client.call = async (method, args) => {
    const result = await call(method, args);
    if (method === "cron.list") {
      f.assistants.runtime.client.call = call;
      reached();
      await new Promise((r) => {
        release = r;
      });
    }
    return result;
  };
  const completion = f.reminders.complete(binding.id, {
    jobId: job.id,
    runAtMs: 123,
    status: "ok",
    summary: "Late",
  });
  await waiting;
  await f.reminders.remove(f.id, binding.id);
  release();
  await completion;
  assert.equal(f.reminders.bindings.get(binding.id).state, "removed");
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
});
test("preparation failures can retry before any native creation was submitted", async (t) => {
  const f = setup(t);
  f.assistants.config.apply = async () => {
    throw Error("Temporary configuration failure");
  };
  await assert.rejects(f.reminders.create(f.id, f.input));
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 0);
  f.assistants.config.apply = async () => {};
  assert.equal((await f.reminders.create(f.id, f.input)).status, "ready");
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 1);
});
test("runtime maintenance detects native scheduled turns outside the chat ledger", async (t) => {
  const f = setup(t);
  await f.reminders.create(f.id, f.input);
  const job = [...f.jobs.values()][0];
  assert.equal(await f.reminders.hasRunning(), false);
  job.state.runningAtMs = Date.now();
  assert.equal(await f.reminders.hasRunning(), true);
  delete job.state.runningAtMs;
  assert.equal(await f.reminders.hasRunning(), false);
});

test("pausing a reminder blocks late completions and queued delivery after adapter recreation", async (t) => {
  const f = setup(t),
    reminder = await f.reminders.create(f.id, f.input),
    job = [...f.jobs.values()][0],
    event = { jobId: job.id, runAtMs: 123, status: "ok", summary: "Buy bread" };
  await f.reminders.complete(reminder.id, event);
  await f.reminders.update(f.id, reminder.id, {
    enabled: false,
    revision: reminder.revision,
  });
  const reopened = new NativeReminders({
    assistants: f.assistants,
    channels: f.service,
    dataDir: f.dataDir,
  });
  f.assistants.reminders = reopened;
  t.after(() => reopened.close());
  await reopened.complete(reminder.id, { ...event, runAtMs: 124 });
  assert.equal(f.service.outbox.all(f.channel.id).length, 1);
  f.client.call = () => assert.fail("paused reminder must not send queued output");
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.outbox.all(f.channel.id)[0].state, "reviewed");
});

test("uncertain reminder pause blocks delivery before RPC completion and until confirmed resume", async (t) => {
  const f = setup(t),
    reminder = await f.reminders.create(f.id, f.input),
    job = [...f.jobs.values()][0],
    event = { jobId: job.id, runAtMs: 123, status: "ok", summary: "Late" },
    call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.update") {
      await call(method, input);
      await f.reminders.complete(reminder.id, event);
      throw Error("Lost acknowledgement");
    }
    return call(method, input);
  };
  await assert.rejects(
    f.reminders.update(f.id, reminder.id, {
      enabled: false,
      revision: reminder.revision,
    }),
  );
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
  const [unknown] = (await f.reminders.list(f.id)).reminders;
  assert.equal(unknown.enabled, false);
  assert.equal(unknown.status, "unknown");
  await assert.rejects(
    f.reminders.update(f.id, reminder.id, {
      enabled: true,
      revision: unknown.revision,
    }),
  );
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
  f.assistants.runtime.client.call = call;
  const resumed = await f.reminders.update(f.id, reminder.id, {
    enabled: true,
    revision: unknown.revision,
  });
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.status, "ready");
  await f.reminders.complete(reminder.id, { ...event, runAtMs: 124 });
  assert.equal(f.service.outbox.all(f.channel.id).length, 1);
});

test("completed one-shots still deliver when native execution disabled the job", async (t) => {
  const f = setup(t),
    reminder = await f.reminders.create(f.id, f.input),
    job = [...f.jobs.values()][0];
  job.enabled = false;
  await f.reminders.complete(reminder.id, {
    jobId: job.id,
    runAtMs: 123,
    status: "ok",
    summary: "Buy bread",
  });
  let sends = 0;
  f.client.call = async () => ({ message_id: ++sends, chat: { id: 42 } });
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(sends, 1);
});

test("disabling reminders keeps queued and late delivery paused when capability returns", async (t) => {
  const f = setup(t),
    reminder = await f.reminders.create(f.id, f.input),
    job = [...f.jobs.values()][0],
    event = { jobId: job.id, runAtMs: 123, status: "ok", summary: "Buy bread" };
  await f.reminders.complete(reminder.id, event);
  await f.reminders.disable(f.id);
  f.store.updateAssistant(f.id, { capabilities: { memory: false, reminders: false } }, 2);
  f.store.updateAssistant(f.id, { capabilities: { memory: false, reminders: true } }, 3);
  await f.reminders.complete(reminder.id, { ...event, runAtMs: 124 });
  assert.equal(f.service.outbox.all(f.channel.id).length, 1);
  f.client.call = () => assert.fail("capability restoration must not resume delivery");
  await f.service.teamOutbox.process(f.channel.id, new AbortController().signal);
  assert.equal(f.service.outbox.all(f.channel.id)[0].state, "reviewed");
});
test("one-shot reminders require an explicit time zone offset", async (t) => {
  const f = setup(t);
  for (const at of ["2026-10-09T09:00", "2026-10-09", "2026-10-09T09:00:00"])
    await assert.rejects(
      f.reminders.create(f.id, { ...f.input, schedule: { kind: "at", at } }),
      { status: 400, message: serverMessages.assistants.reminderTimezoneRequired },
    );
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 0);
  const tools = [];
  plugin.register({
    pluginConfig: {},
    registerTool: (factory) => tools.push(factory),
    on() {},
  });
  for (const name of ["agentpier_reminder", "agentpier_routine"]) {
    const tool = tools
      .map((factory) => factory.create({ agentId: "a", sessionKey: "s" }))
      .find((candidate) => candidate.name === name);
    assert.match(tool.description, /UTC offset/);
  }
});
test("replays never retry a rejected or unconfirmed creation and review resolves it", async (t) => {
  const f = setup(t),
    call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, args) => {
    if (method === "cron.add") {
      f.calls.push({ method, input: args });
      throw Object.assign(Error(), {
        code: args.name === "Rejected" ? "INVALID_REQUEST" : "CLOSED",
      });
    }
    return call(method, args);
  };
  const rejected = { ...f.input, clientRequestId: "rejected", name: "Rejected" };
  await assert.rejects(f.reminders.create(f.id, rejected), { status: 400 });
  await assert.rejects(f.reminders.create(f.id, rejected), { status: 400 });
  await assert.rejects(f.reminders.create(f.id, f.input), { status: 503 });
  await assert.rejects(f.reminders.create(f.id, f.input), {
    status: 409,
    code: "REVIEW_REQUIRED",
    message: serverMessages.assistants.reminderReviewRequired,
  });
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 2);
  const unknown = (await f.reminders.list(f.id)).reminders.find((r) => r.reviewRequired);
  assert.equal(unknown.status, "unknown");
  await assert.rejects(f.reminders.review(f.id, unknown.id, {}), { status: 400 });
  const reviewed = await f.reminders.review(f.id, unknown.id, {
    acknowledgeUnknownOutcome: true,
  });
  assert.equal(reviewed.status, "removed");
  assert.equal((await f.reminders.create(f.id, f.input)).status, "removed");
  await assert.rejects(
    f.reminders.review(f.id, unknown.id, { acknowledgeUnknownOutcome: true }),
    { status: 409 },
  );
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 2);
});
test("review adopts a reminder whose unconfirmed creation reached the runtime", async (t) => {
  const f = setup(t),
    call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, args) => {
    const result = await call(method, args);
    if (method === "cron.add") throw Object.assign(Error(), { code: "CLOSED" });
    return result;
  };
  await assert.rejects(f.reminders.create(f.id, f.input), { status: 503 });
  const binding = f.reminders.bindings.list(f.id)[0];
  const reviewed = await f.reminders.review(f.id, binding.id, {
    acknowledgeUnknownOutcome: true,
  });
  assert.equal(reviewed.status, "ready");
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 1);
});
test("review never closes a reminder whose creation is still in flight", async (t) => {
  const f = setup(t),
    call = f.assistants.runtime.client.call;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  f.assistants.runtime.client.call = async (method, args) => {
    if (method === "cron.add") await gate;
    return call(method, args);
  };
  const creating = f.reminders.create(f.id, f.input);
  await new Promise((resolve) => setImmediate(resolve));
  const binding = f.reminders.bindings.list(f.id)[0];
  assert.equal(binding.state, "pending");
  assert.equal((await f.reminders.list(f.id)).reminders[0].reviewRequired, false);
  await assert.rejects(
    f.reminders.review(f.id, binding.id, { acknowledgeUnknownOutcome: true }),
    { status: 409 },
  );
  release();
  assert.equal((await creating).status, "ready");
  assert.equal(f.reminders.bindings.get(binding.id).state, "bound");
});

for (const language of ["en", "de"])
  test(`failed reminder notices follow the channel language ${language}`, async (t) => {
    const f = setup(t, { language: () => language }),
      reminder = await f.reminders.create(f.id, f.input),
      job = [...f.jobs.values()][0];
    await f.reminders.complete(reminder.id, {
      jobId: job.id,
      runAtMs: 123,
      status: "error",
    });
    const [notice] = f.service.outbox.all(f.channel.id);
    assert.ok(
      notice.parts[0].text.startsWith(serverCatalogs[language].assistants.reminderFailed),
    );
  });

test("a redelivered failure notice survives a language switch while a changed summary still conflicts", async (t) => {
  const f = setup(t, { language: () => "en" }),
    reminder = await f.reminders.create(f.id, f.input),
    job = [...f.jobs.values()][0],
    event = { jobId: job.id, runAtMs: 123, status: "error" };
  await f.reminders.complete(reminder.id, event);
  const [first] = f.service.outbox.all(f.channel.id);
  const channel = f.service.store.get(f.channel.id);
  await f.service.update(f.channel.id, { language: "de", revision: channel.revision });
  await f.reminders.complete(reminder.id, event);
  const all = f.service.outbox.all(f.channel.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].parts[0].text, first.parts[0].text);
  await f.reminders.complete(reminder.id, {
    ...event,
    runAtMs: 124,
    status: "ok",
    summary: "A",
  });
  await assert.rejects(
    f.reminders.complete(reminder.id, {
      ...event,
      runAtMs: 124,
      status: "ok",
      summary: "B",
    }),
    { status: 409 },
  );
});
