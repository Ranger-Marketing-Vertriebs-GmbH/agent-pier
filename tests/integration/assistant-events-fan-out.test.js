import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { AssistantEvents } from "../../server/features/assistants/assistant-events.js";
import { LeadRequests } from "../../server/features/assistants/lead-requests.js";
import { SessionTalk } from "../../server/features/assistants/session-talk/session-talk.js";

// Agent events reach every open agent chat, browser view, waiting ask and live topic
// instance. Each of those used to be its own emitter listener, so a dozen open chats
// or asks passed Node's limit of 10 and logged a MaxListenersExceededWarning; they
// now share one listener per source, and closing them leaves nothing behind.
const many = 12;

function recordWarnings(t) {
  const warnings = [];
  const onWarning = (warning) => {
    if (warning.name === "MaxListenersExceededWarning") warnings.push(warning.message);
  };
  process.on("warning", onWarning);
  t.after(() => process.off("warning", onWarning));
  return warnings;
}

async function until(predicate, label) {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, label);
    await delay(10);
  }
}

test("watchers of agent events share one emitter listener", () => {
  const events = new AssistantEvents();
  const seen = [];
  const stops = Array.from({ length: many }, (_, n) =>
    events.watch((event) => seen.push([n, event.type])),
  );
  assert.equal(events.listenerCount("update"), 1);
  events.publish({ type: "change" });
  assert.equal(seen.length, many);
  assert.deepEqual(seen[0], [0, "change"]);
  for (const stop of stops) stop();
  // A second stop changes nothing.
  for (const stop of stops) stop();
  assert.equal(events.listenerCount("update"), 0);
  events.publish({ type: "change" });
  assert.equal(seen.length, many);
});

test(
  "many open agent chats and session access topics keep agent listeners bounded",
  { timeout: 30000 },
  async (t) => {
    const warnings = recordWarnings(t);
    const f = await applicationFixture(t, enabledAssistants);
    const service = f.application.assistants;
    const feature = f.application.assistantFeature.events;
    const assistant = service.store.createAssistant({
      name: "Fan",
      model: { connectionId: "c", modelId: "m" },
    });
    const conversation = service.store.saveConversation({
      assistantId: assistant.id,
      runtimeSessionKey: "agent:fan:a",
    }).id;
    const updates = () => service.events.listenerCount("update");
    const started = () => feature.listenerCount("started");
    const baseline = { updates: updates(), started: started() };

    const live = openLive(f);
    await live.opened;
    for (let n = 0; n < many; n++)
      live.send({ op: "sub", topic: `session.agent-access:${randomUUID()}` });
    const sockets = Array.from(
      { length: many },
      () =>
        new WebSocket(
          `${f.url.replace("http:", "ws:")}/api/assistant-conversations/${conversation}/stream`,
          { origin: f.url, headers: { cookie: f.cookie } },
        ),
    );
    t.after(() => sockets.forEach((ws) => ws.terminate()));
    await Promise.all(
      sockets.map((ws) => new Promise((resolve) => ws.once("open", resolve))),
    );
    await until(
      () => f.application.live.instances.size >= many,
      "the session access topics are watched",
    );
    await delay(50);
    assert.ok(updates() <= baseline.updates + 1, `update listeners: ${updates()}`);
    assert.ok(started() <= baseline.started + 1, `started listeners: ${started()}`);
    assert.deepEqual(warnings, []);

    for (const ws of sockets) ws.close();
    live.ws.close();
    await live.closed;
    await until(() => updates() === baseline.updates, `update listeners: ${updates()}`);
    await until(() => started() === baseline.started, `started: ${started()}`);
  },
);

test("concurrent lead asks share one agent events listener", async (t) => {
  const warnings = recordWarnings(t);
  const events = new AssistantEvents();
  const rows = new Map();
  const leads = Object.assign(Object.create(LeadRequests.prototype), {
    service: { assistants: { events } },
    store: { get: (id) => rows.get(id) },
    waits: new Map(),
  });
  const inv = { startedAt: Date.now(), assertCurrent() {} };
  const ids = Array.from({ length: many }, (_, n) => `r${n}`);
  for (const id of ids) rows.set(id, { id, phase: "running" });
  const answers = Promise.all(ids.map((id) => leads.waitFor(id, inv, 60000)));
  assert.equal(events.listenerCount("update"), 1);
  for (const id of ids) rows.set(id, { id, phase: "failed" });
  events.publish({ type: "change" });
  assert.deepEqual(
    (await answers).map((r) => r.phase),
    ids.map(() => "failed"),
  );
  assert.equal(events.listenerCount("update"), 0);
  assert.deepEqual(warnings, []);
});

test("concurrent session asks share one agent events listener", async (t) => {
  const warnings = recordWarnings(t);
  const events = new AssistantEvents();
  const rows = new Map();
  const talk = Object.assign(Object.create(SessionTalk.prototype), {
    w: { a: { events } },
    store: {
      get: (id) => rows.get(id),
      patch: (id, fields) => ({ ...rows.get(id), ...fields }),
    },
    waits: new Set(),
    closed: false,
    now: () => Date.now(),
  });
  const ids = Array.from({ length: many }, (_, n) => `s${n}`);
  for (const id of ids) rows.set(id, { id, phase: "pending" });
  const deadline = Date.now() + 60000;
  const answers = Promise.all(ids.map((id) => talk.waitFor(id, { deadline })));
  assert.equal(events.listenerCount("update"), 1);
  for (const id of ids) rows.set(id, { id, phase: "answered" });
  events.publish({ type: "change" });
  assert.deepEqual(
    (await answers).map((r) => r.inline),
    ids.map(() => true),
  );
  assert.equal(events.listenerCount("update"), 0);
  assert.deepEqual(warnings, []);
});
