import test from "node:test";
import assert from "node:assert/strict";
import { NativeRoutines } from "../../server/features/assistants/native-routines.js";
import { routineTools } from "../../server/features/assistants/native-capabilities.js";
import { routineFixture as setup } from "../helpers/native-routines-fixture.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
test("scheduled routines run saved prompts with the agent's tools in its chat and stay distinct from reminders", async (t) => {
  const f = setup(t),
    routine = await f.routines.create(f.id, { ...f.input, telegram: true });
  const job = [...f.jobs.values()][0];
  assert.ok(job.payload.message.endsWith(`\n\n${f.input.prompt}`));
  assert.match(job.payload.message, /not a message from the owner/);
  assert.deepEqual(job.payload.toolsAllow, routineTools);
  assert.equal(job.payload.lightContext, false);
  assert.equal(job.payload.timeoutSeconds, 300);
  // Detached from the paired chat's conversation and committed into it.
  assert.equal(job.sessionTarget, "current");
  assert.equal(job.sessionKey, "session");
  assert.equal(job.delivery.mode, "announce");
  assert.match(job.delivery.completionDestination.to, /\/complete\/[a-f0-9-]{36}$/);
  assert.equal(job.enabled, true);
  assert.deepEqual(job.schedule, f.input.trigger);
  assert.equal(routine.prompt, f.input.prompt);
  assert.equal((await f.reminders.list(f.id)).reminders.length, 0);
  assert.equal((await f.routines.list(f.id)).routines.length, 1);
  await assert.rejects(f.reminders.remove(f.id, routine.id), { status: 404 });
  assert.equal(
    (await f.routines.create(f.id, { ...f.input, telegram: true })).id,
    routine.id,
  );
  assert.equal(f.jobs.size, 1);
  await f.reminders.complete(routine.id, {
    jobId: job.id,
    runAtMs: 123,
    status: "ok",
    summary: "Today's plan: lentil soup.",
  });
  assert.equal(f.service.outbox.all(f.channel.id)[0].text, "Today's plan: lentil soup.");
  assert.ok(!JSON.stringify(routine).includes("http://"));
});
test("event routines remain natively disabled and event receipts survive adapter recreation without replay", async (t) => {
  const f = setup(t),
    routine = await f.routines.create(f.id, { ...f.input, trigger: { kind: "event" } });
  assert.equal([...f.jobs.values()][0].enabled, false);
  assert.equal(routine.enabled, true);
  const first = await f.routines.trigger(f.id, routine.id, { eventId: "owner:123" });
  assert.equal(first.status, "queued");
  const reopened = new NativeRoutines({ reminders: f.reminders });
  assert.deepEqual(
    await reopened.trigger(f.id, routine.id, { eventId: "owner:123" }),
    first,
  );
  assert.equal(f.calls.filter((c) => c.method === "cron.run").length, 1);
  assert.equal(f.calls.find((c) => c.method === "cron.run").input.mode, "force");
});
test("uncertain event submission persists and never automatically runs again", async (t) => {
  const f = setup(t),
    routine = await f.routines.create(f.id, { ...f.input, trigger: { kind: "event" } });
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    const result = await call(method, input);
    if (method === "cron.run") throw Error("private upstream state");
    return result;
  };
  assert.equal(
    (await f.routines.trigger(f.id, routine.id, { eventId: "e1" })).status,
    "unknown",
  );
  const reopened = new NativeRoutines({ reminders: f.reminders });
  assert.equal(
    (await reopened.trigger(f.id, routine.id, { eventId: "e1" })).status,
    "unknown",
  );
  assert.equal(f.calls.filter((c) => c.method === "cron.run").length, 1);
});
test("pause and removal block event admission and late completion delivery", async (t) => {
  const f = setup(t),
    routine = await f.routines.create(f.id, { ...f.input, trigger: { kind: "event" } });
  const paused = await f.routines.update(f.id, routine.id, {
    enabled: false,
    revision: routine.revision,
  });
  assert.equal(paused.enabled, false);
  await assert.rejects(f.routines.trigger(f.id, routine.id, { eventId: "e1" }), {
    status: 409,
  });
  await f.reminders.complete(routine.id, {
    jobId: [...f.jobs.keys()][0],
    runAtMs: 123,
    status: "ok",
    summary: "Late",
  });
  assert.equal(f.service.outbox.all(f.channel.id).length, 0);
  const resumed = await f.routines.update(f.id, routine.id, {
    enabled: true,
    revision: paused.revision,
  });
  assert.equal(resumed.enabled, true);
  assert.equal([...f.jobs.values()][0].enabled, false);
  await f.routines.remove(f.id, routine.id);
  await assert.rejects(f.routines.trigger(f.id, routine.id, { eventId: "e1" }));
  assert.equal(f.jobs.size, 0);
});
test("routines require opt-in and reject unexpected event input or schedule injection", async (t) => {
  const f = setup(t);
  await assert.rejects(
    f.routines.create(f.id, {
      ...f.input,
      trigger: { kind: "event", expr: "* * * * *" },
    }),
    { status: 400 },
  );
  const routine = await f.routines.create(f.id, {
    ...f.input,
    trigger: { kind: "event" },
  });
  await assert.rejects(
    f.routines.trigger(f.id, routine.id, { eventId: "e1", prompt: "injected" }),
    { status: 400 },
  );
  f.store.updateAssistant(f.id, { capabilities: { memory: false, reminders: false } }, 2);
  await assert.rejects(f.routines.trigger(f.id, routine.id, { eventId: "e1" }), {
    status: 403,
  });
});
test("coding completion only runs subscribed routines and global disable pauses event routines", async (t) => {
  const f = setup(t);
  await f.routines.create(f.id, {
    ...f.input,
    trigger: { kind: "event", eventKind: "manual" },
  });
  const subscribed = await f.routines.create(f.id, {
    ...f.input,
    clientRequestId: "coding",
    trigger: { kind: "event", eventKind: "coding.completed" },
  });
  assert.equal(
    (
      await f.routines.emit({
        assistantId: f.id,
        kind: "coding.completed",
        eventId: "run-1",
      })
    )[0].id,
    subscribed.id,
  );
  await f.routines.emit({
    assistantId: f.id,
    kind: "coding.completed",
    eventId: "run-1",
  });
  assert.equal(f.calls.filter((c) => c.method === "cron.run").length, 1);
  await f.reminders.disable(f.id);
  assert.equal(
    (await f.routines.list(f.id)).routines.every((r) => !r.enabled),
    true,
  );
  assert.deepEqual(
    await f.routines.emit({
      assistantId: f.id,
      kind: "coding.completed",
      eventId: "run-2",
    }),
    [],
  );
});
test("lost scheduled pause response stays uncertain and blocked until a confirmed update", async (t) => {
  const f = setup(t),
    routine = await f.routines.create(f.id, f.input),
    call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.update") throw Error("connection lost before response");
    return call(method, input);
  };
  await assert.rejects(
    f.routines.update(f.id, routine.id, { enabled: false, revision: routine.revision }),
  );
  const [unknown] = (await f.routines.list(f.id)).routines;
  assert.equal(unknown.status, "unknown");
  assert.equal(
    f.reminders.acceptsDelivery({ source: { reminderBindingId: routine.id } }),
    false,
  );
  f.assistants.runtime.client.call = call;
  const paused = await f.routines.update(f.id, routine.id, {
    enabled: false,
    revision: unknown.revision,
  });
  assert.equal(paused.status, "ready");
  assert.equal(paused.enabled, false);
});
test("an unconfirmed routine creation asks for review instead of resubmitting", async (t) => {
  const f = setup(t),
    call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method === "cron.add") {
      f.calls.push({ method, input });
      throw Object.assign(Error(), { code: "CLOSED" });
    }
    return call(method, input);
  };
  await assert.rejects(f.routines.create(f.id, f.input), { status: 503 });
  await assert.rejects(f.routines.create(f.id, f.input), {
    status: 409,
    code: "REVIEW_REQUIRED",
    message: serverMessages.assistants.routineReviewRequired,
  });
  const [pending] = (await f.routines.list(f.id)).routines;
  assert.equal(pending.reviewRequired, true);
  const reviewed = await f.routines.review(f.id, pending.id, {
    acknowledgeUnknownOutcome: true,
  });
  assert.equal(reviewed.status, "removed");
  assert.equal((await f.routines.create(f.id, f.input)).status, "removed");
  assert.equal(f.calls.filter((c) => c.method === "cron.add").length, 1);
});
test("a coding.completed routine whose native job vanished is skipped permanently", async (t) => {
  const f = setup(t);
  const routine = await f.routines.create(f.id, {
    ...f.input,
    trigger: { kind: "event", eventKind: "coding.completed" },
  });
  f.jobs.clear();
  assert.deepEqual(
    await f.routines.emit({ assistantId: f.id, kind: "coding.completed", eventId: "r" }),
    [{ id: routine.id, status: "skipped", reason: "NOT_FOUND" }],
  );
  assert.equal(f.calls.filter((c) => c.method === "cron.run").length, 0);
});
test("only the owner marks a routine as one that may delegate writing tasks", async (t) => {
  const f = setup(t);
  const audits = [];
  f.assistants.audit = { append: (event) => audits.push(event) };
  const routine = await f.routines.create(f.id, f.input);
  assert.equal(routine.delegateWrites, false);
  const marked = await f.routines.update(f.id, routine.id, {
    delegateWrites: true,
    revision: routine.revision,
  });
  assert.equal(marked.delegateWrites, true);
  assert.equal(marked.revision, routine.revision + 1);
  assert.equal(
    marked.enabled,
    routine.enabled,
    "the switch alone leaves the job as it is",
  );
  assert.deepEqual(audits.at(-1).details, {
    kind: "routine-delegate-writes",
    routineId: routine.id,
    delegateWrites: true,
  });
  await assert.rejects(
    f.routines.update(f.id, routine.id, { delegateWrites: "yes", revision: 2 }),
    { status: 400 },
  );
  // Reminders have no such switch.
  await assert.rejects(
    f.reminders.update(f.id, routine.id, { delegateWrites: true, revision: 1 }),
    { status: 400 },
  );
  const off = await f.routines.update(f.id, routine.id, {
    delegateWrites: false,
    revision: marked.revision,
  });
  assert.equal(off.delegateWrites, false);
});
