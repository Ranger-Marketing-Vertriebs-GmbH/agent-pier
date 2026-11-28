import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { EventEmitter } from "node:events";
import express from "express";
import {
  applicationFixture,
  enabledAssistants,
  fixtureFetch,
} from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { manualTimers } from "../helpers/manual-timers.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { assistantRoutes } from "../../server/http/routes/assistants.js";
import { semanticMemoryTopic } from "../../server/features/assistants/live-runtime-topics.js";

// The owner's semantic memory search over HTTP and the live channel
// (routes/assistant-semantic-memory.js, live topic `runtime.semantic-memory`).

test("the API is owner-only, starts off and refuses to switch on a stopped agent service", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const endpoint = f.url + "/api/assistant-semantic-memory";
  assert.equal((await fetch(endpoint)).status, 401);
  const initial = await fixtureFetch(endpoint);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("cache-control"), "no-store");
  const body = await initial.json();
  assert.equal(body.state, "off");
  assert.equal(body.enabled, false);
  assert.equal(body.revision, 1);
  assert.equal(body.model.size, 328577056);
  // No Gateway runs in this fixture, so it cannot be switched on; the reason is told.
  assert.equal(body.available, false);
  assert.equal(body.reason, "SERVICE_STOPPED");
  const put = (input) =>
    fixtureFetch(endpoint, {
      method: "PUT",
      headers: { origin: f.url, "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  const invalid = await put({ enabled: "yes" });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "SEMANTIC_MEMORY_INVALID");
  const stale = await put({ enabled: true, revision: 9, acceptTerms: true });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "SEMANTIC_MEMORY_CONFLICT");
  const stopped = await put({ enabled: true, revision: 1, acceptTerms: true });
  assert.equal(stopped.status, 409);
  assert.deepEqual(await stopped.json(), {
    code: "SEMANTIC_MEMORY_SERVICE_STOPPED",
    error: "SEMANTIC_MEMORY_SERVICE_STOPPED",
  });
  // Nothing was switched, saved or downloaded.
  assert.deepEqual(await (await fixtureFetch(endpoint)).json(), body);
  // The live topic carries the same value.
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "runtime.semantic-memory" });
  const first = await live.next(
    (frame) => frame.topic === "runtime.semantic-memory",
    5000,
  );
  assert.equal(first.type, "snapshot");
  assert.deepEqual(first.data, body);
  live.ws.close();
});

test("with agents off the route and the topic answer like every agent route", async (t) => {
  const f = await applicationFixture(t);
  assert.equal((await f.request("/api/assistant-semantic-memory")).status, 404);
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "runtime.semantic-memory" });
  assert.deepEqual(
    await live.next((frame) => frame.topic === "runtime.semantic-memory", 5000),
    {
      type: "error",
      topic: "runtime.semantic-memory",
    },
  );
  live.ws.close();
});

test("a switch answers 202 with the first state; a refusal carries only its code", async (t) => {
  const calls = [];
  const app = express();
  app.use(express.json());
  app.use(
    assistantRoutes({
      assistantFeature: { enabled: true },
      assistants: { maintenance: false },
      assistantSemanticMemory: {
        status: () => ({ state: "on", enabled: true, revision: 4 }),
        set(input) {
          calls.push(input);
          if (input.revision === 3)
            throw Object.assign(new Error("/private/path in a message"), {
              code: "OPERATION_RUNNING",
              status: 409,
            });
          if (input.revision === 2) throw new Error("unexpected");
          return { state: "downloading", enabled: false, revision: 2 };
        },
      },
    }),
  );
  app.use((error, _req, res, _next) => res.status(500).json({ error: "internal" }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const put = (body) =>
    fetch(`http://127.0.0.1:${server.address().port}/assistant-semantic-memory`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const started = await put({ enabled: true, revision: 1, acceptTerms: true, extra: 1 });
  assert.equal(started.status, 202);
  assert.deepEqual(await started.json(), {
    state: "downloading",
    enabled: false,
    revision: 2,
  });
  // Only the known fields reach the service.
  assert.deepEqual(calls[0], {
    enabled: true,
    revision: 1,
    acceptTerms: true,
    repair: false,
  });
  // The repair of a degraded search is the same switch with `repair`.
  await put({ enabled: true, revision: 1, repair: true });
  assert.deepEqual(calls[1], {
    enabled: true,
    revision: 1,
    acceptTerms: undefined,
    repair: true,
  });
  const running = await put({ enabled: false, revision: 3 });
  assert.equal(running.status, 409);
  assert.deepEqual(await running.json(), {
    code: "SEMANTIC_MEMORY_OPERATION_RUNNING",
    error: "SEMANTIC_MEMORY_OPERATION_RUNNING",
  });
  assert.equal((await put({ enabled: true, revision: 2 })).status, 500);
  assert.equal((await put([1])).status, 202);
  assert.deepEqual(calls.at(-1), {
    enabled: undefined,
    revision: undefined,
    acceptTerms: undefined,
    repair: false,
  });
});

test("the topic pushes each change the service signals and nothing is sampled", async (t) => {
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  let status = { state: "off", enabled: false, revision: 1 };
  let opened = 0;
  const services = {
    assistantFeature: { enabled: true, events: new EventEmitter() },
    assistants: {},
    assistantSemanticMemory: { status: () => status, opened: () => opened++ },
  };
  const topic = semanticMemoryTopic(services);
  assert.equal(topic.authorize({ role: "owner" }), true);
  assert.equal(topic.authorize({ role: "user" }), false);
  assert.equal(topic.authorize(null), false);
  assert.equal(topic.sampleMs, undefined);
  hub.define(topic);
  const frames = [];
  hub.subscribe({ role: "owner" }, "runtime.semantic-memory", undefined, (f) =>
    frames.push(f),
  );
  await clock.advance(0);
  assert.deepEqual(frames[0].data, status);
  // The first watcher (the owner opening the Runtime tab) has the service check
  // whether embeddings answer; a second tab does not ask again.
  assert.equal(opened, 1);
  hub.subscribe({ role: "owner" }, "runtime.semantic-memory", undefined, () => {});
  await clock.advance(0);
  assert.equal(opened, 1);
  // A search that answered without embeddings is a change like any other.
  status = {
    state: "degraded",
    degraded: { code: "EMBEDDINGS_UNAVAILABLE" },
    revision: 2,
  };
  hub.invalidate("runtime.semantic-memory");
  await clock.advance(1000);
  assert.deepEqual(frames.at(-1).data, status);
  // Each step of a download is a change the service signals itself.
  for (const received of [10, 20]) {
    status = { state: "downloading", progress: { received, total: 100 }, revision: 2 };
    hub.invalidate("runtime.semantic-memory");
    await clock.advance(1000);
    assert.deepEqual(frames.at(-1).data, status);
  }
  const count = frames.length;
  await clock.advance(10 * 60000);
  assert.equal(frames.length, count, "no timed read");
  // An unchanged value is not pushed again.
  hub.invalidate("runtime.semantic-memory");
  await clock.advance(1000);
  assert.equal(frames.length, count);
});
