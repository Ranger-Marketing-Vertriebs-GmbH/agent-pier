import test from "node:test";
import assert from "node:assert/strict";
import { conversationHistory } from "../../server/features/assistants/conversations.js";
import {
  body,
  done,
  event,
  hookFixture,
  makeHook,
} from "../helpers/agent-hook-fixture.js";

// The hook fixture's agent with a Gateway serving `page()` as its main chat's history.
async function eventChat(t, page = () => []) {
  const f = hookFixture(t);
  const main = f.reminders.mainConversation(f.id);
  const service = {
    store: f.store,
    ledger: f.assistants.ledger,
    routines: f.routines,
    runtime: {
      generation: 1,
      client: {
        ready: true,
        call: async (method, input) => {
          assert.equal(method, "chat.history");
          return { messages: input.sessionKey === main.runtimeSessionKey ? page() : [] };
        },
      },
    },
  };
  return {
    f,
    main,
    service,
    history: (id = main.id) => conversationHistory(service, id),
  };
}
const turn = (role, text, timestamp, id) => ({
  role,
  content: [{ type: "text", text }],
  timestamp,
  __openclaw: { id },
});

test("the main chat's view carries the event area, other chats none", async (t) => {
  const now = Date.now();
  const { f, main, service, history } = await eventChat(t, () => [
    turn("assistant", "Lentil soup today.", now + 1, "m-routine"),
    turn("user", "Thanks", now + 3, "m-user"),
  ]);
  const record = (entry) =>
    f.routines.results.record({
      conversationId: main.id,
      runAtMs: 0,
      status: "ok",
      ...entry,
    });
  record({
    id: "r",
    name: "Meal plan",
    at: now - 30,
    text: "Lentil soup today.",
    committed: true,
  });
  record({
    id: "c",
    kind: "heartbeat",
    name: "",
    at: now - 20,
    text: "All quiet.\nNothing new.",
    committed: false,
  });
  record({
    id: "m",
    kind: "reminder",
    name: "Call",
    at: now - 10,
    text: "Call mum.",
    committed: false,
  });
  await f.hooks.deliver(makeHook(f), body('{"id":"p1"}'));
  const view = await history();
  assert.deepEqual(
    view.events.map((e) => [e.id.split(":")[0], e.source, e.status]),
    [
      ["hook", "hook", "running"],
      ["routine", "checkin", "done"],
      ["routine", "routine", "done"],
    ],
  );
  assert.equal(view.events[1].firstLine, "All quiet.");
  assert.equal(view.events[2].name, "Meal plan");
  // The routine's committed reply and the check-in leave the transcript; the
  // reminder (kept with its text) and the owner's message stay.
  assert.deepEqual(
    view.messages.map((m) => [m.role, m.text, m.scheduled?.kind ?? null]),
    [
      ["assistant", "Call mum.", "reminder"],
      ["user", "Thanks", null],
    ],
  );
  const other = f.store.saveConversation({
    assistantId: f.id,
    runtimeSessionKey: "other-session",
  });
  assert.notEqual(other.id, main.id);
  assert.deepEqual((await conversationHistory(service, other.id)).events, []);
});

test("a hook event in the area shows status, duplicates and first line, not the payload", async (t) => {
  let prompt = null;
  const { f, history } = await eventChat(t, () => [
    // Should OpenClaw ever show the run's prompt as a turn, it stays hidden.
    ...(prompt ? [turn("user", prompt, Date.now(), "m-prompt")] : []),
    turn("assistant", "Disk on db1 is full.\nThe log grew.", Date.now(), "m-reply"),
  ]);
  const hook = makeHook(f);
  const text = '{"id":"p1","note":"PAYLOAD_MARK <b>x</b>"}';
  await f.hooks.deliver(hook, body(text));
  await f.hooks.deliver(hook, body(text));
  const stored = event(f, hook, "p1");
  prompt = f.jobs.get(stored.jobId).payload.message;
  assert.ok(prompt.includes("PAYLOAD_MARK"));
  await f.hooks.runs.complete(
    stored.id,
    done(stored.jobId, { summary: "\n  Disk on db1 is full.\nThe log grew." }),
  );
  const view = await history();
  assert.deepEqual(view.events, [
    {
      id: `hook:${stored.id}`,
      source: "hook",
      name: "Zabbix",
      sender: "zabbix01",
      at: stored.receivedAt,
      status: "done",
      duplicates: 1,
      firstLine: "Disk on db1 is full.",
      reply: "Disk on db1 is full.\nThe log grew.",
      hookId: hook.id,
      eventId: stored.id,
    },
  ]);
  // Neither the reply OpenClaw committed nor the prompt with its payload is a message.
  assert.deepEqual(view.messages, []);
  assert.ok(!JSON.stringify(view).includes("PAYLOAD_MARK"));
});

test("the event detail returns the payload cut to 16 KiB as text", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  // 3-byte characters: 16384 is no character boundary, the cut moves before it.
  const text = JSON.stringify({ id: "big", note: `<b>x</b>${"€".repeat(6000)}` });
  await f.hooks.deliver(hook, body(text));
  const stored = event(f, hook, "big");
  f.assistants.workflows.get = (id) =>
    ({
      a1: { id: "a1", assistantId: f.id, state: "running", run: { url: "/old" } },
      other: { id: "other", assistantId: "someone-else", state: "running" },
    })[id];
  f.assistants.workflows.liveRun = (a) =>
    a.id === "a1" ? { run: { url: "http://127.0.0.1:4380/pipelines/runs/r1" } } : {};
  f.hooks.events.patch(stored.id, { coding: ["a1", "other", "gone"] });
  await f.hooks.runs.complete(stored.id, done(stored.jobId, { summary: "Looked." }));
  const detail = f.hooks.eventDetail(f.id, hook.id, stored.id);
  assert.equal(detail.payloadCut, true);
  assert.equal(typeof detail.payload, "string");
  assert.ok(Buffer.byteLength(detail.payload) <= 16384);
  assert.ok(Buffer.byteLength(detail.payload) > 16380);
  assert.ok(text.startsWith(detail.payload));
  assert.ok(detail.payload.includes("<b>x</b>"), "kept as literal text");
  assert.deepEqual(
    { ...detail, payload: undefined },
    {
      receivedAt: new Date(stored.receivedAt).toISOString(),
      size: Buffer.byteLength(text),
      contentType: "application/json",
      source: "local",
      payload: undefined,
      payloadCut: true,
      activity: [],
      coding: [
        {
          actionId: "a1",
          state: "running",
          runUrl: "http://127.0.0.1:4380/pipelines/runs/r1",
        },
      ],
      remote: [],
      notified: { push: true, telegram: false },
      reply: "Looked.",
    },
  );
  // A small payload is whole; another hook's event or an unknown one is not found.
  await f.hooks.deliver(hook, body('{"id":"small"}'));
  const small = event(f, hook, "small");
  assert.deepEqual(
    [
      f.hooks.eventDetail(f.id, hook.id, small.id).payload,
      f.hooks.eventDetail(f.id, hook.id, small.id).payloadCut,
    ],
    ['{"id":"small"}', false],
  );
  const second = makeHook(f, { name: "Other" });
  for (const [hookId, id] of [
    [second.id, stored.id],
    [hook.id, "missing"],
    ["missing", stored.id],
  ])
    assert.throws(() => f.hooks.eventDetail(f.id, hookId, id), { status: 404 });
});

test("the event detail lists the SSH, SFTP and coding runs of that event only", async (t) => {
  const f = hookFixture(t);
  const hook = makeHook(f);
  await f.hooks.deliver(hook, body('{"id":"one"}'));
  await f.hooks.deliver(hook, body('{"id":"two"}'));
  const one = event(f, hook, "one");
  const two = event(f, hook, "two");
  const origin = (e) => ({ kind: "hook", hookId: hook.id, eventId: e.id });
  const actions = [
    {
      id: "s1",
      assistantId: f.id,
      origin: origin(one),
      state: "completed",
      payload: { action: "ssh", hostName: "db1" },
    },
    {
      id: "s2",
      assistantId: f.id,
      origin: origin(two),
      state: "completed",
      payload: { action: "ssh", hostName: "db2" },
    },
    {
      id: "f1",
      assistantId: f.id,
      origin: origin(one),
      state: "failed",
      payload: { action: "sftp", hostName: "files" },
    },
    {
      id: "c1",
      assistantId: f.id,
      origin: origin(one),
      state: "running",
      payload: { action: "coding_start" },
    },
    {
      id: "x1",
      assistantId: f.id,
      origin: { kind: "routine" },
      state: "completed",
      payload: { action: "ssh", hostName: "db1" },
    },
  ];
  Object.assign(f.assistants.workflows, {
    store: { list: (id) => actions.filter((a) => a.assistantId === id) },
    get: (id) => actions.find((a) => a.id === id),
    liveRun: () => ({}),
  });
  const detail = f.hooks.eventDetail(f.id, hook.id, one.id);
  assert.deepEqual(detail.remote, [
    { actionId: "s1", kind: "ssh", host: "db1", state: "completed" },
    { actionId: "f1", kind: "sftp", host: "files", state: "failed" },
  ]);
  assert.deepEqual(detail.coding, [{ actionId: "c1", state: "running", runUrl: null }]);
  assert.deepEqual(
    f.hooks.eventDetail(f.id, hook.id, two.id).remote.map((a) => a.actionId),
    ["s2"],
  );
});
