import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RequestBroker } from "../../server/features/requests/request-broker.js";
import { NativeRequestChannel } from "../../server/features/requests/native-channel.js";
import {
  REQUESTS_SAMPLE_MS,
  requestsChanged,
  sessionRequestsTopic,
} from "../../server/features/requests/live-topics.js";
import {
  MODELS_SAMPLE_MS,
  sessionModelsTopic,
} from "../../server/features/models/live-topics.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { ChatEvents } from "../../server/features/chat/chat-events.js";
import { composerScreen } from "../fixtures/requests/claude-startup-prompts.js";

const owner = { role: "owner" };
const request = {
  kind: "permission",
  options: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
  subject: { command: "fixture command" },
};

/**
 * A running Claude session with its native channel and binding (so it is in its
 * startup window until the binding goes), a broker wired to the hub as services.js
 * wires it, and both topics with short samplers.
 */
async function fixture(t, { requestsSampleMs = 30, modelsSampleMs = 100 } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-live-session-"));
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const session = {
    id: "fixture",
    tool: "claude",
    accountId: "account",
    status: "running",
    cwd,
    nativeRequests: { enabled: true },
    nativeBinding: { enabled: true },
  };
  const counts = { screens: 0, models: 0 };
  const services = { live: null, chatEvents: new ChatEvents() };
  const sessions = {
    get: async (id) => {
      if (id !== session.id) throw new Error("unknown session");
      return session;
    },
    control: async (_id, operation) =>
      operation({
        session,
        screen: async () => {
          counts.screens += 1;
          return composerScreen();
        },
      }),
  };
  const broker = new RequestBroker({
    dataDir: root,
    sessions,
    onEvent: (event) => requestsChanged(services.live, event.sessionId),
    onChange: (sessionId) => requestsChanged(services.live, sessionId),
  });
  const launch = await broker.prepare({
    id: session.id,
    account: { id: "account", tool: "claude" },
    cwd,
    launch: { command: "/fixture/claude", args: [], env: {} },
  });
  const bindingFile = path.join(root, "native-sessions", "fixture.launch.json");
  await fs.mkdir(path.dirname(bindingFile));
  await fs.writeFile(
    bindingFile,
    JSON.stringify({
      id: session.id,
      accountId: session.accountId,
      tool: "claude",
      cwd,
      token: "binding",
    }),
  );
  Object.assign(services, {
    requests: broker,
    sessions,
    models: {
      read: async () => {
        counts.models += 1;
        return { currentModel: "opus", picker: null };
      },
    },
  });
  const hub = new LiveHub({ debounceMs: 10, maxWaitMs: 50 });
  hub.define(sessionRequestsTopic(services, { sampleMs: requestsSampleMs }));
  hub.define(sessionModelsTopic(services, { sampleMs: modelsSampleMs }));
  services.live = hub;
  const channel = new NativeRequestChannel({ env: launch.env });
  t.after(async () => {
    hub.close();
    channel.close();
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await channel.ready;
  return { broker, channel, hub, counts, services, bindingFile, session };
}

function subscribe(hub, topicId) {
  const frames = [];
  const waiters = [];
  const stop = hub.subscribe(owner, topicId, undefined, (frame) => {
    frames.push(frame);
    for (const waiter of [...waiters])
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
  });
  const next = (predicate = () => true, timeout = 2000) => {
    const found = frames.find((frame) => !frame.taken && predicate(frame));
    if (found) {
      found.taken = true;
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame")), timeout);
      waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          frame.taken = true;
          resolve(frame);
        },
      });
    });
  };
  return { frames, next, stop };
}

const listed = (frame) => frame.data?.requests?.length > 0;
async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await delay(5);
  }
}

test("the topics keep the planned samplers", () => {
  assert.equal(REQUESTS_SAMPLE_MS, 1500);
  assert.equal(MODELS_SAMPLE_MS, 3000);
  const services = {};
  assert.equal(sessionRequestsTopic(services).sampleMs, 1500);
  assert.equal(sessionModelsTopic(services).sampleMs, 3000);
  assert.equal(typeof sessionRequestsTopic(services).sampling, "function");
});

test("a created request reaches a subscriber within 1 s", async (t) => {
  const f = await fixture(t, { requestsSampleMs: 60000 });
  const tab = subscribe(f.hub, "session.requests:fixture");
  const snapshot = await tab.next();
  assert.equal(snapshot.type, "snapshot");
  assert.deepEqual(snapshot.data.requests, []);
  const started = Date.now();
  f.channel.publish("native-1", request, async () => {});
  const frame = await tab.next(listed, 1000);
  assert.ok(Date.now() - started < 1000);
  assert.equal(frame.type, "state");
  assert.equal(frame.data.requests[0].subject.command, "fixture command");
  assert.ok(frame.revision > snapshot.revision);
  tab.stop();
});

test("an unchanged request list sends no frame across ten samples", async (t) => {
  const f = await fixture(t);
  f.channel.publish("native-1", request, async () => {});
  await until(() => f.broker.hasPending("fixture"));
  const [entry] = (await f.broker.list("fixture")).requests;
  // A touch makes the list carry an age that grows with every read.
  await f.broker.touch("fixture", entry.id, { client: "other" });
  const tab = subscribe(f.hub, "session.requests:fixture");
  const snapshot = await tab.next(listed);
  assert.equal(snapshot.data.requests[0].interaction.client, "other");
  const screens = f.counts.screens;
  // The session is in its startup window, so every sample reads its screen.
  await until(() => f.counts.screens >= screens + 10);
  assert.deepEqual(
    tab.frames.map((frame) => frame.type),
    ["snapshot"],
  );
  tab.stop();
});

test("a touch from another client pushes a frame", async (t) => {
  const f = await fixture(t, { requestsSampleMs: 60000 });
  f.channel.publish("native-1", request, async () => {});
  await until(() => f.broker.hasPending("fixture"));
  const tab = subscribe(f.hub, "session.requests:fixture");
  const snapshot = await tab.next(listed);
  assert.equal(snapshot.data.requests[0].interaction, undefined);
  await f.broker.touch("fixture", snapshot.data.requests[0].id, { client: "other" });
  const frame = await tab.next((next) => next.type === "state", 1000);
  assert.equal(frame.data.requests[0].interaction.client, "other");
  assert.equal(typeof frame.data.requests[0].interaction.age, "number");
  tab.stop();
});

test("a terminal notice and its clearing push frames", async (t) => {
  const f = await fixture(t, { requestsSampleMs: 60000 });
  const tab = subscribe(f.hub, "session.requests:fixture");
  await tab.next();
  f.broker.terminalNotice({
    id: "a".repeat(64),
    sessionId: "fixture",
    source: "claude",
    kind: "permission",
  });
  const shown = await tab.next((frame) => frame.type === "state", 1000);
  assert.deepEqual(shown.data.notice, { id: "a".repeat(64), reason: "terminal" });
  f.broker.clearNotice("fixture");
  const cleared = await tab.next((frame) => frame.type === "state", 1000);
  assert.equal(cleared.data.notice, undefined);
  tab.stop();
});

test("the startup sampler stops after the startup window", async (t) => {
  const f = await fixture(t);
  const tab = subscribe(f.hub, "session.requests:fixture");
  await tab.next();
  const screens = f.counts.screens;
  await until(() => f.counts.screens >= screens + 3);
  // The window closes once the session's startup state is gone.
  await fs.rm(f.bindingFile);
  await delay(100);
  const settled = f.counts.screens;
  await delay(300);
  assert.equal(f.counts.screens, settled);
  tab.stop();
});

// The sampler runs every 300 ms here instead of 3 s; the planned value is checked above.
test("two tabs on one session cause one models read per 3 s", async (t) => {
  const f = await fixture(t, { modelsSampleMs: 300 });
  const first = subscribe(f.hub, "session.models:fixture");
  const second = subscribe(f.hub, "session.models:fixture");
  const [a, b] = await Promise.all([first.next(), second.next()]);
  assert.equal(a.type, "snapshot");
  assert.deepEqual(a.data, b.data);
  const started = Date.now();
  const reads = f.counts.models;
  await delay(1500);
  const samples = Math.floor((Date.now() - started) / 300);
  assert.ok(f.counts.models - reads <= samples + 1, `${f.counts.models - reads} reads`);
  assert.ok(f.counts.models - reads >= samples - 2, `${f.counts.models - reads} reads`);
  // The value did not change: no frame after the snapshot.
  assert.equal(first.frames.length + second.frames.length, 2);
  first.stop();
  second.stop();
});

test("native activity samples the models at once", async (t) => {
  const f = await fixture(t, { modelsSampleMs: 60000 });
  const tab = subscribe(f.hub, "session.models:fixture");
  await tab.next();
  const reads = f.counts.models;
  f.services.chatEvents.publish("fixture", "native-activity");
  await until(() => f.counts.models > reads, 1000);
  tab.stop();
});

test("no subscriber, no models read", async (t) => {
  const f = await fixture(t, { modelsSampleMs: 50 });
  await delay(300);
  assert.equal(f.counts.models, 0);
  const tab = subscribe(f.hub, "session.models:fixture");
  await tab.next();
  tab.stop();
  const reads = f.counts.models;
  await delay(300);
  assert.equal(f.counts.models, reads);
});

test("a user and a malformed id do not resolve", async (t) => {
  const f = await fixture(t);
  const frames = [];
  f.hub.subscribe({ role: "user" }, "session.models:fixture", undefined, (frame) =>
    frames.push(frame),
  );
  f.hub.subscribe(owner, "session.requests:../x", undefined, (frame) =>
    frames.push(frame),
  );
  assert.deepEqual(
    frames.map((frame) => frame.code),
    ["unknown-topic", "unknown-topic"],
  );
  assert.equal(f.counts.models, 0);
});
