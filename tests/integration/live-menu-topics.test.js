import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { manualTimers } from "../helpers/manual-timers.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import {
  WRITE_SIGNALED_TOPICS,
  liveWriteSignals,
  reportLiveError,
} from "../../server/application/live-wiring.js";
import { settingsSummaryTopic } from "../../server/features/settings/live-topics.js";
import {
  CONNECTION_PROBLEMS_SAMPLE_MS,
  connectionProblemsTopic,
} from "../../server/features/providers/live-topics.js";
import {
  RUNTIME_UPDATES_SAMPLE_MS,
  runtimeUpdatesTopic,
} from "../../server/features/assistants/live-runtime-topics.js";

// The menu-hint topics: the settings summary, the connection problems and the agent
// runtime's update status, each the value its REST route answers.
const menuTopics = {
  "settings.summary": "/api/settings/summary",
  "connections.problems": "/api/connections/problems",
};

async function listening(f, ...topics) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  const first = {};
  for (const topic of topics) {
    live.send({ op: "sub", topic });
    first[topic] = await live.next((frame) => frame.topic === topic, 5000);
  }
  return { live, first };
}

const json = async (f, path) => (await f.request(path)).json();

// Every console.error while `t` runs.
function errorsOf(t) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });
  return errors;
}

test("each menu-hint snapshot equals its REST route", async (t) => {
  const f = await applicationFixture(t);
  const { live, first } = await listening(f, ...Object.keys(menuTopics));
  for (const [topic, path] of Object.entries(menuTopics)) {
    assert.equal(first[topic].type, "snapshot", topic);
    assert.deepEqual(first[topic].data, await json(f, path), topic);
  }
  live.ws.close();
});

test("an owner write pushes the summary and the problems within 1 s", async (t) => {
  const f = await applicationFixture(t);
  const { live, first } = await listening(f, ...Object.keys(menuTopics));
  assert.deepEqual(first["settings.summary"].data.access.secrets, { count: 0 });
  assert.equal(first["connections.problems"].data.secrets.total, 0);
  // Each frame is awaited from the write on, 1 s apiece.
  const pushed = Promise.all([
    live.next((frame) => frame.topic === "settings.summary", 1000),
    live.next((frame) => frame.topic === "connections.problems", 1000),
  ]);
  const created = await f.request("/api/secrets", {
    method: "POST",
    body: { name: "API_KEY", description: "", value: "value-1f9" },
  });
  assert.equal(created.status, 201);
  const [summary, problems] = await pushed;
  assert.equal(summary.type, "state");
  assert.deepEqual(summary.data, await json(f, "/api/settings/summary"));
  assert.deepEqual(summary.data.access.secrets, { count: 1 });
  assert.equal(problems.type, "state");
  assert.deepEqual(problems.data, await json(f, "/api/connections/problems"));
  assert.equal(problems.data.secrets.total, 1);
  // No secret value travels in either frame.
  assert.doesNotMatch(JSON.stringify([summary, problems]), /value-1f9/);
  live.ws.close();
});

test("a failed write and a read change nothing", async (t) => {
  const f = await applicationFixture(t);
  const { live } = await listening(f, ...Object.keys(menuTopics));
  const refused = await f.request("/api/secrets", { method: "POST", body: {} });
  assert.ok(refused.status >= 400);
  await f.request("/api/settings/summary");
  await assert.rejects(live.next((frame) => frame.type === "state", 1200));
  live.ws.close();
});

test("with agents off the update topic answers an error once and logs nothing", async (t) => {
  const f = await applicationFixture(t);
  const errors = errorsOf(t);
  assert.equal(f.application.assistants, null);
  assert.equal((await f.request("/api/assistant-runtime/updates")).status, 404);
  const { live, first } = await listening(f, "runtime.updates");
  assert.deepEqual(first["runtime.updates"], { type: "error", topic: "runtime.updates" });
  await assert.rejects(
    live.next((frame) => frame.topic === "runtime.updates", 1200),
    /no matching frame/,
  );
  assert.deepEqual(
    errors.filter((line) => line.includes("live topic")),
    [],
  );
  live.ws.close();
});

// The hub with manual timers, for the samplers.
function hubOf(t) {
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  return { clock, hub };
}

const owner = { role: "owner" };

function listen(hub, topic, principal = owner) {
  const frames = [];
  const stop = hub.subscribe(principal, topic, undefined, (frame) => frames.push(frame));
  return { frames, stop };
}

// Agent services whose update status the test sets; `reads` counts status() calls.
function agentServices(update = { updateAvailable: false }) {
  const feature = new EventEmitter();
  const services = {
    reads: 0,
    update,
    assistantFeature: { enabled: true, events: feature },
    assistants: {},
    assistantUpdates: {
      status: () => {
        services.reads += 1;
        return structuredClone(services.update);
      },
    },
  };
  return services;
}

test("the update status is sampled every 60 s, only while someone subscribes", async (t) => {
  assert.equal(RUNTIME_UPDATES_SAMPLE_MS, 60000);
  const { clock, hub } = hubOf(t);
  const services = agentServices();
  hub.define(runtimeUpdatesTopic(services));
  await clock.advance(120000);
  assert.equal(services.reads, 0);
  const { frames, stop } = listen(hub, "runtime.updates");
  await clock.advance(0);
  assert.equal(services.reads, 1);
  assert.deepEqual(frames[0].data, { updateAvailable: false });
  await clock.advance(59000);
  assert.equal(services.reads, 1);
  services.update = { updateAvailable: true };
  await clock.advance(1000);
  assert.equal(services.reads, 2);
  assert.equal(frames.at(-1).type, "state");
  assert.deepEqual(frames.at(-1).data, { updateAvailable: true });
  // An unchanged sample sends nothing.
  await clock.advance(60000);
  assert.equal(services.reads, 3);
  assert.equal(frames.length, 2);
  stop();
  await clock.advance(600000);
  assert.equal(services.reads, 3);
});

test("agents switched on or off read the update status again", async (t) => {
  const { clock, hub } = hubOf(t);
  const services = agentServices();
  hub.define(runtimeUpdatesTopic(services));
  const { frames } = listen(hub, "runtime.updates");
  await clock.advance(0);
  services.assistants = null;
  services.assistantFeature.events.emit("stopped");
  await clock.advance(1000);
  // The refusal once, so the tab reads the route's answer.
  assert.deepEqual(frames.slice(1), [{ type: "error", topic: "runtime.updates" }]);
  services.assistants = {};
  services.update = { updateAvailable: true };
  services.assistantFeature.events.emit("started");
  await clock.advance(1000);
  assert.deepEqual(frames.at(-1).data, { updateAvailable: true });
});

test("without agent services the update topic refuses with the route's status, expected", async () => {
  const off = runtimeUpdatesTopic({ assistants: null, assistantUpdates: null });
  await assert.rejects(
    async () => off.read(owner),
    (error) => error.status === 404 && error.expected === true,
  );
  const down = runtimeUpdatesTopic({
    assistantFeature: { enabled: true },
    assistants: null,
    assistantUpdates: null,
  });
  await assert.rejects(
    async () => down.read(owner),
    (error) => error.status === 503 && error.expected === true,
  );
});

test("the hub logs a failed read, but no refusal and no expected failure", (t) => {
  const errors = errorsOf(t);
  reportLiveError(Object.assign(new Error("x"), { status: 503, expected: true }), {
    topic: "runtime.updates",
  });
  reportLiveError(Object.assign(new Error("x"), { status: 404 }), { topic: "a" });
  assert.deepEqual(errors, []);
  reportLiveError(Object.assign(new Error("x"), { status: 503 }), { topic: "b" });
  reportLiveError(new Error("x"), { topic: "c" });
  assert.deepEqual(errors, [
    "AgentPier could not update the live topic b.",
    "AgentPier could not update the live topic c.",
  ]);
});

test("the problems are sampled every 60 s, only while someone subscribes", async (t) => {
  assert.equal(CONNECTION_PROBLEMS_SAMPLE_MS, 60000);
  const { clock, hub } = hubOf(t);
  let reads = 0;
  const services = {
    providerConnections: {
      list: () => {
        reads += 1;
        return [];
      },
    },
    accounts: { list: () => [] },
  };
  hub.define(connectionProblemsTopic(services));
  await clock.advance(120000);
  assert.equal(reads, 0);
  const { stop } = listen(hub, "connections.problems");
  await clock.advance(0);
  assert.equal(reads, 1);
  await clock.advance(59999);
  assert.equal(reads, 1);
  await clock.advance(1);
  assert.equal(reads, 2);
  stop();
  await clock.advance(600000);
  assert.equal(reads, 2);
});

test("the settings summary is not sampled", () => {
  const topic = settingsSummaryTopic({});
  assert.equal(topic.sampleMs, undefined);
  assert.equal(topic.mode, "state");
});

test("every menu-hint topic is the owner's alone", () => {
  for (const topic of [
    settingsSummaryTopic({}),
    connectionProblemsTopic({}),
    runtimeUpdatesTopic({}),
  ]) {
    assert.equal(topic.authorize(owner), true, topic.name);
    assert.equal(topic.authorize({ role: "user", userId: "u1" }), false, topic.name);
    assert.equal(topic.authorize(null), false, topic.name);
    assert.equal(topic.param, undefined, topic.name);
  }
});

test("only a successful write outside the frequent areas signals the topics", () => {
  const signaled = [];
  const services = { live: { invalidate: (topic) => signaled.push(topic) } };
  const middleware = liveWriteSignals(services);
  const send = (method, path, statusCode) => {
    const res = new EventEmitter();
    res.statusCode = statusCode;
    let passed = false;
    middleware({ method, path }, res, () => (passed = true));
    assert.equal(passed, true);
    res.emit("finish");
  };
  send("GET", "/settings/summary", 200);
  send("POST", "/sessions/s1/input", 200);
  send("PATCH", "/me/password", 200);
  // Chat, native-request answers and agent chats stay quiet.
  send("POST", "/sessions/s1/chat", 200);
  send("POST", "/sessions/s1/requests/r1/answer", 200);
  send("POST", "/assistant-conversations/c1/messages", 200);
  send("POST", "/secrets", 400);
  assert.deepEqual(signaled, []);
  send("DELETE", "/secrets/x", 204);
  assert.deepEqual(signaled, [...WRITE_SIGNALED_TOPICS]);
  assert.deepEqual(WRITE_SIGNALED_TOPICS, [
    "settings.summary",
    "connections.problems",
    "runtime.updates",
  ]);
});
