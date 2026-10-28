import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { manualTimers } from "../helpers/manual-timers.js";
import { subscribe } from "../helpers/live-hub-subscriber.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { reportLiveError } from "../../server/application/live-wiring.js";
import { ChatEvents } from "../../server/features/chat/chat-events.js";
import { SessionReload } from "../../server/features/sessions/session-reload.js";
import {
  RELOAD_SAMPLE_MS,
  reloadChanged,
  sessionReloadTopic,
} from "../../server/features/sessions/live-reload-topic.js";
import { assistantAccountRoutes } from "../../server/http/routes/assistant-accounts.js";

// The live `session.reload:<id>` topic, and the Task 3.2 topics against their REST
// routes in a running application.

const user = { role: "user", userId: "u1" };

function errorsOf(t) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });
  return errors;
}

test("every write of a reload state signals its session", async (t) => {
  const errors = errorsOf(t);
  const session = { id: "session-one", reload: null };
  const services = {
    sessions: {
      get: async () => session,
      updateReload: async (_id, reload) => (session.reload = reload),
    },
  };
  const reload = new SessionReload({ services, pollMs: 0 });
  const signals = [];
  reload.onChange = (id) => signals.push([id, session.reload.state]);
  await reload.save(session, { state: "waiting" });
  await reload.save(session, { state: "idle" });
  assert.deepEqual(signals, [
    ["session-one", "waiting"],
    ["session-one", "idle"],
  ]);
  reload.onChange = () => {
    throw new Error("listener");
  };
  await reload.save(session, { state: "waiting" });
  assert.equal(session.reload.state, "waiting");
  assert.ok(errors.some((line) => /session reload/.test(line)));
});

test("session.reload is sampled, signalled and nudged by native activity", async (t) => {
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  const chatEvents = new ChatEvents();
  let state = "idle",
    reads = 0;
  const services = {
    chatEvents,
    reload: {
      status: async () => {
        reads += 1;
        return { state, activity: { state: "busy" } };
      },
    },
  };
  hub.define(sessionReloadTopic(services));
  assert.equal(
    subscribe(hub, "session.reload:session-one", user).frames[0].code,
    "unknown-topic",
  );
  const live = subscribe(hub, "session.reload:session-one");
  await clock.advance(0);
  assert.equal(live.frames[0].data.state, "idle");
  // The CLI's activity announces nothing: sampled at the dialog's former poll.
  await clock.advance(RELOAD_SAMPLE_MS);
  assert.equal(reads, 2);
  state = "waiting";
  reloadChanged(hub, "session-one");
  await clock.advance(1000);
  assert.equal(live.frames.at(-1).data.state, "waiting");
  const before = reads;
  chatEvents.publish("session-one", "native-activity");
  await clock.advance(200);
  assert.equal(reads, before + 1);
  live.stop();
  assert.equal(chatEvents.subscribers.size, 0);
});

test("an unknown session's reload is a refusal, not logged", async (t) => {
  const errors = errorsOf(t);
  const hub = new LiveHub({ debounceMs: 5, maxWaitMs: 20, onError: reportLiveError });
  t.after(() => hub.close());
  const missing = Object.assign(new Error("Session not found"), { status: 404 });
  hub.define(
    sessionReloadTopic({
      reload: {
        status: async () => {
          throw missing;
        },
      },
    }),
  );
  assert.equal((await subscribe(hub, "session.reload:gone").next()).type, "error");
  assert.deepEqual(errors, []);
});

test("GET /assistant-model-login/current answers the latest attempt", async (t) => {
  const login = {
    attempt: null,
    status(id = this.attempt?.id) {
      if (!this.attempt || id !== this.attempt.id)
        throw Object.assign(new Error("missing"), { status: 404 });
      return { id: this.attempt.id, status: this.attempt.status };
    },
  };
  const app = express();
  app.use(assistantAccountRoutes({ assistantModelLogin: login }));
  app.use((error, _req, res, _next) => res.status(error.status).json({}));
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${base}/assistant-model-login/current`)).status, 404);
  login.attempt = { id: "a1", status: "awaiting_user" };
  const current = await (await fetch(`${base}/assistant-model-login/current`)).json();
  assert.deepEqual(current, { id: "a1", status: "awaiting_user" });
  assert.deepEqual(
    await (await fetch(`${base}/assistant-model-login/a1`)).json(),
    current,
  );
});

const json = async (f, route) => (await f.request(route)).json();

test("the package, SSH and reload topics equal their routes", async (t) => {
  const f = await applicationFixture(t);
  const app = f.application;
  const server = app.mcpServers.create({
    name: "packaged",
    transport: "http",
    url: "https://mcp.example.test/mcp",
  });
  app.mcpPackages.records.put(server.id, {
    registry: "npm",
    name: "server-x",
    version: "1.0.0",
    program: "server-x",
    programPath: "",
    allowScripts: false,
    lock: "",
    lockDigest: "",
    integrity: "",
    installId: null,
    leadingArgs: 0,
    toolchainDir: null,
    status: "failed",
    errorCode: "MCP_PACKAGE_INSTALL_FAILED",
  });
  const route = `/api/mcp-servers/${server.id}/package`;
  const topic = `job.mcp-package:${server.id}`;
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic });
  const first = await live.next((frame) => frame.topic === topic, 5000);
  assert.equal(first.type, "snapshot");
  assert.deepEqual(first.data, await json(f, route));
  // The wired hooks push: a job's start, its log and its end.
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const running = live.next(
    (frame) => frame.topic === topic && frame.data?.job?.log === "step\n",
    5000,
  );
  app.mcpPackages.jobs.run(server.id, { kind: "reinstall" }, async (log) => {
    log("step");
    await gate;
  });
  assert.deepEqual((await running).data, await json(f, route));
  const ended = live.next(
    (frame) => frame.topic === topic && frame.data?.job?.state === "done",
    5000,
  );
  release();
  assert.deepEqual((await ended).data, await json(f, route));
  // Unknown sessions and an absent sign-in are refused like their routes.
  for (const [other, path, status] of [
    ["job.ssh-tools:gone", "/api/sessions/gone/ssh-accesses", 404],
    ["session.reload:gone", "/api/sessions/gone/reload", 404],
    ["job.mcp-package:gone", "/api/mcp-servers/gone/package", 404],
  ]) {
    assert.equal((await f.request(path)).status, status, path);
    live.send({ op: "sub", topic: other });
    assert.equal((await live.next((frame) => frame.topic === other, 5000)).type, "error");
  }
  live.ws.close();
});
