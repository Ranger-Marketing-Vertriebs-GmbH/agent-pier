import test from "node:test";
import assert from "node:assert/strict";
import { routineFixture } from "../helpers/native-routines-fixture.js";
import { body, event, hookFixture, makeHook } from "../helpers/agent-hook-fixture.js";
import { NativeHeartbeats } from "../../server/features/assistants/native-heartbeats.js";
import { checkInPrompt } from "../../server/features/assistants/native-heartbeats.js";
import { routineTools } from "../../server/features/assistants/native-capabilities.js";
import { pauseOwnJobs } from "../../server/features/assistants/agent-own-jobs.js";
import { leadRoutineFixture } from "../helpers/lead-routine-fixture.js";

// AGENTPIER-319: callers build AgentPier's routine model (routine-definition.js) and
// the OpenClaw adapter translates it. These pin the cron requests each caller sent
// before the model, field for field, so the Gateway sees the same payloads.
const sent = (f, method) =>
  f.calls.filter((c) => c.method === method).map((c) => c.input);
const sessionOf = (f) =>
  f.store.getConversation(f.reminders.mainConversation(f.id).id).runtimeSessionKey;

test("a reminder submits the cron job it always did", async (t) => {
  const f = routineFixture(t);
  const reminder = await f.reminders.create(f.id, {
    clientRequestId: "reminder-1",
    name: "Water",
    message: "Drink water.",
    schedule: { kind: "at", at: "2099-01-01T09:00:00+01:00" },
  });
  const { url } = await f.reminders.start();
  const agent = f.store.getAssistant(f.id);
  assert.deepEqual(sent(f, "cron.add"), [
    {
      name: "Water",
      declarationKey: `agentpier-reminder:${reminder.id}`,
      agentId: agent.runtimeAgentId,
      enabled: true,
      deleteAfterRun: false,
      // reminder-input.js stores the time in UTC.
      schedule: { kind: "at", at: "2099-01-01T08:00:00.000Z" },
      wakeMode: "now",
      failureAlert: false,
      sessionTarget: "isolated",
      payload: {
        kind: "agentTurn",
        message:
          "Deliver this reminder by returning its text verbatim. Do not use tools.\n\nDrink water.",
        timeoutSeconds: 90,
        lightContext: true,
        toolsAllow: [],
      },
      delivery: { mode: "webhook", to: `${url}/complete/${reminder.id}` },
    },
  ]);
  // The owner's view reads the routine back as before.
  assert.deepEqual(reminder.schedule, { kind: "at", at: "2099-01-01T08:00:00.000Z" });
  assert.equal(reminder.revision, 1);
  const paused = await f.reminders.update(f.id, reminder.id, {
    enabled: false,
    revision: 1,
  });
  assert.equal(paused.enabled, false);
  await f.reminders.remove(f.id, reminder.id);
  const id = "job-0";
  assert.deepEqual(sent(f, "cron.update"), [{ id, patch: { enabled: false } }]);
  assert.deepEqual(sent(f, "cron.remove"), [{ id }]);
});

test("a routine submits, edits, pauses, re-targets and runs its job as before", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, f.input);
  const { url } = await f.reminders.start();
  const agent = f.store.getAssistant(f.id);
  const message = [
    'This is the scheduled AgentPier routine "Meal plan", not a message from the owner.',
    "Carry out its saved task below and reply with the result for the owner.",
    "",
    "Create a vegetarian meal plan for today.",
  ].join("\n");
  const payload = (text = message) => ({
    kind: "agentTurn",
    message: text,
    timeoutSeconds: 300,
    lightContext: false,
    toolsAllow: [...routineTools],
  });
  const delivery = {
    mode: "announce",
    completionDestination: { mode: "webhook", to: `${url}/complete/${routine.id}` },
  };
  assert.deepEqual(sent(f, "cron.add"), [
    {
      name: "Meal plan",
      declarationKey: `agentpier-reminder:${routine.id}`,
      agentId: agent.runtimeAgentId,
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
      wakeMode: "now",
      failureAlert: false,
      sessionTarget: "current",
      sessionKey: sessionOf(f),
      payload: payload(),
      delivery,
    },
  ]);
  assert.deepEqual(routine.schedule, {
    kind: "cron",
    expr: "0 9 * * *",
    tz: "Europe/Berlin",
  });
  // A job as it was submitted is current: a sync changes nothing.
  await f.routines.sync(f.id);
  assert.deepEqual(sent(f, "cron.update"), []);
  const edited = await f.routines.update(f.id, routine.id, {
    name: "Lunch plan",
    trigger: { kind: "cron", expr: "0 11 * * 1-5", tz: "Europe/Berlin" },
    revision: 1,
  });
  await f.routines.update(f.id, routine.id, {
    enabled: false,
    revision: edited.revision,
  });
  const lunch = message.replace('"Meal plan"', '"Lunch plan"');
  // A job from before the commit into the chat is brought to the run settings.
  const job = f.jobs.get("job-0");
  f.jobs.set("job-0", { ...job, sessionTarget: "isolated", payload: { kind: "x" } });
  await f.routines.sync(f.id);
  assert.deepEqual(sent(f, "cron.update"), [
    {
      id: "job-0",
      patch: {
        name: "Lunch plan",
        schedule: { kind: "cron", expr: "0 11 * * 1-5", tz: "Europe/Berlin" },
        payload: payload(lunch),
      },
    },
    { id: "job-0", patch: { enabled: false } },
    {
      id: "job-0",
      patch: {
        sessionTarget: "current",
        sessionKey: sessionOf(f),
        payload: payload(lunch),
        delivery,
      },
    },
  ]);
});

test("an event routine is a disabled job forced to run", async (t) => {
  const f = routineFixture(t);
  const routine = await f.routines.create(f.id, {
    ...f.input,
    trigger: { kind: "event", eventKind: "manual" },
  });
  const [added] = sent(f, "cron.add");
  assert.equal(added.enabled, false);
  assert.deepEqual(added.schedule, { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" });
  await f.routines.trigger(f.id, routine.id, { eventId: "e1" });
  assert.deepEqual(sent(f, "cron.run"), [{ id: "job-0", mode: "force" }]);
});

test("a check-in submits and updates its job as before", async (t) => {
  const f = routineFixture(t);
  const heartbeat = { enabled: true, interval: "4h", start: 8, end: 20 };
  const save = (patch) =>
    f.store.updateAssistant(f.id, patch, f.store.getAssistant(f.id).revision);
  save({
    capabilities: { memory: true, reminders: false },
    heartbeat: { ...heartbeat, timeZone: "Europe/Berlin" },
  });
  const heartbeats = new NativeHeartbeats({ reminders: f.reminders });
  await heartbeats.sync(f.id);
  const { url } = await f.reminders.start();
  const [added] = sent(f, "cron.add");
  const binding = added.declarationKey.slice("agentpier-reminder:".length);
  const payload = {
    kind: "agentTurn",
    message: checkInPrompt(null),
    timeoutSeconds: 120,
    lightContext: false,
    toolsAllow: ["memory_search", "memory_get"],
  };
  assert.deepEqual(added, {
    name: "AgentPier check-in",
    declarationKey: `agentpier-reminder:${binding}`,
    agentId: f.store.getAssistant(f.id).runtimeAgentId,
    enabled: true,
    deleteAfterRun: false,
    schedule: { kind: "cron", expr: "0 8,12,16 * * *", tz: "Europe/Berlin" },
    payload,
    sessionTarget: "current",
    sessionKey: sessionOf(f),
    wakeMode: "now",
    failureAlert: false,
    delivery: {
      mode: "announce",
      completionDestination: { mode: "webhook", to: `${url}/complete/${binding}` },
    },
  });
  await heartbeats.sync(f.id);
  assert.deepEqual(sent(f, "cron.update"), [], "an unchanged check-in stays");
  save({ heartbeat: { ...heartbeat, timeZone: "UTC" } });
  await heartbeats.sync(f.id);
  assert.deepEqual(sent(f, "cron.update"), [
    {
      id: "job-0",
      patch: {
        schedule: { kind: "cron", expr: "0 8,12,16 * * *", tz: "UTC" },
        payload,
        enabled: true,
      },
    },
  ]);
});

test("a hook run submits, forces and removes its job as before", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f, { instruction: "Tell me which host." });
  await f.hooks.deliver(hook, body('{"id":"p1"}'));
  const stored = event(f, hook, "p1");
  const { url } = await f.reminders.start();
  const [added] = sent(f, "cron.add");
  assert.deepEqual(Object.keys(added).sort(), [
    "agentId",
    "declarationKey",
    "deleteAfterRun",
    "delivery",
    "enabled",
    "failureAlert",
    "name",
    "payload",
    "schedule",
    "sessionKey",
    "sessionTarget",
    "wakeMode",
  ]);
  assert.deepEqual(
    { ...added, payload: { ...added.payload, message: "…" } },
    {
      name: "Hook Zabbix",
      declarationKey: `agentpier-hook:${stored.id}`,
      agentId: f.runtimeAgentId,
      enabled: false,
      deleteAfterRun: false,
      schedule: { kind: "cron", expr: "0 0 1 1 *", tz: "UTC" },
      wakeMode: "now",
      failureAlert: false,
      sessionTarget: "current",
      sessionKey: "session",
      payload: {
        kind: "agentTurn",
        message: "…",
        timeoutSeconds: 300,
        lightContext: false,
        toolsAllow: [
          "session_status",
          "memory_search",
          "memory_get",
          "agentpier_share_file",
          "agentpier_pinboard",
          "agentpier_card",
        ],
      },
      delivery: {
        mode: "announce",
        completionDestination: {
          mode: "webhook",
          to: `${url}/hook-complete/${stored.id}`,
        },
      },
    },
  );
  assert.deepEqual(sent(f, "cron.run"), [{ id: "job-0", mode: "force" }]);
  // Settled hook jobs go on the next reconcile.
  f.hooks.events.patch(stored.id, { status: "done" });
  await f.hooks.runs.reconcile();
  assert.deepEqual(sent(f, "cron.remove"), [{ id: "job-0" }]);
});

test("an archive pauses only the jobs an agent made itself", async (t) => {
  const f = routineFixture(t);
  await f.routines.create(f.id, f.input);
  const agent = f.store.getAssistant(f.id);
  // The agent's own cron job: no AgentPier declaration, a system event payload.
  f.jobs.set("own-1", {
    id: "own-1",
    agentId: agent.runtimeAgentId,
    enabled: true,
    schedule: { kind: "every", everyMs: 60000 },
    payload: { kind: "systemEvent", text: "Stretch." },
    updatedAtMs: 1,
  });
  const before = f.calls.length;
  assert.deepEqual(await pauseOwnJobs(f.assistants, agent), { paused: ["own-1"] });
  assert.deepEqual(
    f.calls.slice(before).filter((c) => c.method === "cron.update"),
    [{ method: "cron.update", input: { id: "own-1", patch: { enabled: false } } }],
  );
});

test("a lead's routine on its member submits and removes its job as before", async (t) => {
  const f = await leadRoutineFixture(t);
  const calls = [];
  const call = f.assistants.runtime.client.call;
  f.assistants.runtime.client.call = async (method, input) => {
    if (method.startsWith("cron.")) calls.push({ method, input });
    return call(method, input);
  };
  const created = await f.create();
  const { url } = await f.reminders.start();
  const [added] = calls.filter((c) => c.method === "cron.add").map((c) => c.input);
  const session = f.store.getConversation(
    f.reminders.mainConversation(f.member.id).id,
  ).runtimeSessionKey;
  assert.deepEqual(
    { ...added, payload: { ...added.payload, message: "…" } },
    {
      name: "Inbox check",
      declarationKey: `agentpier-reminder:${created.id}`,
      agentId: f.member.runtimeAgentId,
      enabled: true,
      deleteAfterRun: false,
      schedule: { kind: "cron", expr: "0 9 * * *", tz: "Europe/Berlin" },
      wakeMode: "now",
      failureAlert: false,
      sessionTarget: "current",
      sessionKey: session,
      payload: {
        kind: "agentTurn",
        message: "…",
        timeoutSeconds: 300,
        lightContext: false,
        toolsAllow: [...routineTools],
      },
      delivery: {
        mode: "announce",
        completionDestination: { mode: "webhook", to: `${url}/complete/${created.id}` },
      },
    },
  );
  assert.match(added.payload.message, /that your lead agent set up for you/);
  await f.tool("remove", { id: created.id });
  assert.deepEqual(
    calls.filter((c) => c.method === "cron.remove").map((c) => c.input),
    [{ id: "job-0" }],
  );
});
