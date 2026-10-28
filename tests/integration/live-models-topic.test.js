import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  MODELS_SAMPLE_MS,
  sessionModelsTopic,
} from "../../server/features/models/live-topics.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { ChatEvents } from "../../server/features/chat/chat-events.js";
import { serverMessages } from "../../server/lib/i18n/de.js";
import { subscribe, until } from "../helpers/live-hub-subscriber.js";

const topic = "session.models:fixture";
const failure = (message, status = 409) => Object.assign(new Error(message), { status });

// The models topic over a fake session whose model read the test steers: `fail`
// throws, `hang` never answers. `logs` collects what the topic logs.
function fixture(t, { sampleMs = 100, timeoutMs = 200 } = {}) {
  const session = { id: "fixture", tool: "codex", status: "running" };
  const steer = { fail: null, hang: false, reads: 0 };
  const logs = [];
  const services = {
    chatEvents: new ChatEvents(),
    sessions: { get: async () => session },
    models: {
      read: async () => {
        steer.reads += 1;
        if (steer.hang) return new Promise(() => {});
        if (steer.fail) throw steer.fail;
        return { currentModel: "opus", picker: null };
      },
    },
  };
  const hub = new LiveHub({ debounceMs: 10, maxWaitMs: 50 });
  hub.define(
    sessionModelsTopic(services, { sampleMs, timeoutMs, log: (line) => logs.push(line) }),
  );
  t.after(() => hub.close());
  return { hub, session, steer, logs, services };
}

test("the topic keeps the planned sampler", () => {
  assert.equal(MODELS_SAMPLE_MS, 3000);
  assert.equal(sessionModelsTopic({}).sampleMs, 3000);
});

// The sampler runs every 300 ms here instead of 3 s; the planned value is checked above.
test("two tabs on one session cause one models read per 3 s", async (t) => {
  const f = fixture(t, { sampleMs: 300 });
  const first = subscribe(f.hub, topic);
  const second = subscribe(f.hub, topic);
  const [a, b] = await Promise.all([first.next(), second.next()]);
  assert.equal(a.type, "snapshot");
  assert.deepEqual(a.data, b.data);
  const started = Date.now();
  const reads = f.steer.reads;
  await delay(1500);
  const samples = Math.floor((Date.now() - started) / 300);
  assert.ok(f.steer.reads - reads <= samples + 1, `${f.steer.reads - reads} reads`);
  assert.ok(f.steer.reads - reads >= samples - 2, `${f.steer.reads - reads} reads`);
  assert.equal(first.frames.length + second.frames.length, 2);
  first.stop();
  second.stop();
});

test("native activity samples the models at once", async (t) => {
  const f = fixture(t, { sampleMs: 60000 });
  const tab = subscribe(f.hub, topic);
  await tab.next();
  const reads = f.steer.reads;
  f.services.chatEvents.publish("fixture", "native-activity");
  await until(() => f.steer.reads > reads, 1000);
  tab.stop();
});

test("no subscriber, no models read", async (t) => {
  const f = fixture(t, { sampleMs: 50 });
  await delay(300);
  assert.equal(f.steer.reads, 0);
  const tab = subscribe(f.hub, topic);
  await tab.next();
  tab.stop();
  const reads = f.steer.reads;
  await delay(300);
  assert.equal(f.steer.reads, reads);
});

for (const [name, change] of [
  ["stopped", (session) => (session.status = "stopped")],
  ["reloading", (session) => (session.reload = { state: "reloading" })],
  ["shell", (session) => (session.tool = "shell")],
  ["login", (session) => (session.purpose = "login")],
])
  test(`a ${name} session is not sampled`, async (t) => {
    const f = fixture(t, { sampleMs: 30 });
    const tab = subscribe(f.hub, topic);
    await tab.next();
    change(f.session);
    await delay(100);
    const reads = f.steer.reads;
    await delay(300);
    assert.equal(f.steer.reads, reads);
    tab.stop();
  });

test("a reloading read is pushed once as data and logs nothing", async (t) => {
  const f = fixture(t, { sampleMs: 30 });
  const tab = subscribe(f.hub, topic);
  await tab.next();
  f.steer.fail = failure(serverMessages.sessions.reloading);
  const frame = await tab.next((next) => next.type === "state");
  assert.deepEqual(frame.data, {
    currentModel: "opus",
    picker: null,
    error: { code: "reloading" },
  });
  const reads = f.steer.reads;
  await until(() => f.steer.reads >= reads + 5);
  assert.equal(tab.frames.length, 2);
  assert.deepEqual(f.logs, []);
  f.steer.fail = null;
  const recovered = await tab.next((next) => next.type === "state");
  assert.equal(recovered.data.error, undefined);
  tab.stop();
});

test("another refusal carries the server's message", async (t) => {
  const f = fixture(t);
  f.steer.fail = failure(serverMessages.sessions.shellModelPickerUnavailable);
  const tab = subscribe(f.hub, topic);
  const snapshot = await tab.next();
  assert.deepEqual(snapshot.data, {
    error: {
      code: "unavailable",
      message: serverMessages.sessions.shellModelPickerUnavailable,
    },
  });
  assert.deepEqual(f.logs, []);
  tab.stop();
});

test("a hung read times out once, is not started twice and is logged never", async (t) => {
  const f = fixture(t, { sampleMs: 30, timeoutMs: 100 });
  const tab = subscribe(f.hub, topic);
  await tab.next();
  f.steer.hang = true;
  const frame = await tab.next((next) => next.type === "state", 2000);
  assert.deepEqual(frame.data.error, { code: "timeout" });
  const reads = f.steer.reads;
  await delay(400);
  assert.equal(f.steer.reads, reads);
  assert.equal(tab.frames.length, 2);
  assert.deepEqual(f.logs, []);
  tab.stop();
});

test("an unexpected failure is logged once per change", async (t) => {
  const f = fixture(t, { sampleMs: 30 });
  const tab = subscribe(f.hub, topic);
  await tab.next();
  f.steer.fail = new Error("tmux exploded");
  const frame = await tab.next((next) => next.type === "state");
  assert.deepEqual(frame.data.error, { code: "unavailable" });
  const reads = f.steer.reads;
  await until(() => f.steer.reads >= reads + 5);
  assert.equal(f.logs.length, 1);
  assert.doesNotMatch(f.logs[0], /tmux exploded/);
  tab.stop();
});
