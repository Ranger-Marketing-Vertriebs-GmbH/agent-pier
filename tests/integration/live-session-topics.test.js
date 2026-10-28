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
import { LiveHub } from "../../server/features/live/live-hub.js";
import { ChatEvents } from "../../server/features/chat/chat-events.js";
import { composerScreen } from "../fixtures/requests/claude-startup-prompts.js";
import { STARTUP_GRACE_MS } from "../../server/features/requests/claude-startup-prompts.js";
import { subscribe, until } from "../helpers/live-hub-subscriber.js";

const request = {
  kind: "permission",
  options: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
  subject: { command: "fixture command" },
};
const topic = "session.requests:fixture";
const listed = (frame) => frame.data?.requests?.length > 0;
const pushed = (frame) => frame.type === "state";

/**
 * A running Claude session with its native channel and binding, still in its startup
 * (Claude has written no receipt yet), a broker wired to the hub as services.js wires
 * it, and the topic with a short sampler. `startupDone()` writes the receipt.
 */
async function fixture(t, { sampleMs = 30, graceMs = 0 } = {}) {
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
  const counts = { screens: 0 };
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
  const bindings = path.join(root, "native-sessions");
  await fs.mkdir(bindings);
  const binding = { id: session.id, accountId: "account", tool: "claude", cwd };
  await fs.writeFile(
    path.join(bindings, "fixture.launch.json"),
    JSON.stringify({ ...binding, token: "binding" }),
  );
  const startupDone = () =>
    fs.writeFile(
      path.join(bindings, "fixture.receipt.json"),
      JSON.stringify({ token: "binding" }),
    );
  Object.assign(services, { requests: broker, sessions });
  const hub = new LiveHub({ debounceMs: 10, maxWaitMs: 50 });
  hub.define(sessionRequestsTopic(services, { sampleMs, graceMs }));
  services.live = hub;
  const channel = new NativeRequestChannel({ env: launch.env });
  t.after(async () => {
    hub.close();
    channel.close();
    await broker.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await channel.ready;
  return { broker, channel, hub, counts, services, startupDone };
}

async function pending(f) {
  f.channel.publish("native-1", request, async () => {});
  await until(() => f.broker.hasPending("fixture"));
}

test("the topic keeps the planned sampler", () => {
  assert.equal(REQUESTS_SAMPLE_MS, 1500);
  const definition = sessionRequestsTopic({});
  assert.equal(definition.sampleMs, 1500);
  assert.equal(typeof definition.sampling, "function");
});

test("a created request reaches a subscriber within 1 s", async (t) => {
  const f = await fixture(t, { sampleMs: 60000 });
  const tab = subscribe(f.hub, topic);
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
  await pending(f);
  const [entry] = (await f.broker.list("fixture")).requests;
  // A touch makes the list carry an age that grows with every read.
  await f.broker.touch("fixture", entry.id, { client: "other" });
  const tab = subscribe(f.hub, topic);
  const snapshot = await tab.next(listed);
  assert.equal(snapshot.data.requests[0].interaction.client, "other");
  const screens = f.counts.screens;
  // The session is still starting, so every sample reads its screen.
  await until(() => f.counts.screens >= screens + 10);
  assert.deepEqual(
    tab.frames.map((frame) => frame.type),
    ["snapshot"],
  );
  tab.stop();
});

test("a touch from another client pushes its moment and the frame's server time", async (t) => {
  const f = await fixture(t, { sampleMs: 60000 });
  await pending(f);
  const tab = subscribe(f.hub, topic);
  const snapshot = await tab.next(listed);
  assert.equal(snapshot.data.requests[0].interaction, undefined);
  const before = Date.now();
  await f.broker.touch("fixture", snapshot.data.requests[0].id, { client: "other" });
  const frame = await tab.next(pushed, 1000);
  const { interaction } = frame.data.requests[0];
  assert.equal(interaction.client, "other");
  assert.equal(interaction.at % 1000, 0);
  assert.ok(Math.abs(interaction.at - before) <= 1000);
  assert.ok(frame.data.sampledAt >= before);
  tab.stop();
});

test("a late subscriber's cached list carries the time it is sent", async (t) => {
  const f = await fixture(t, { sampleMs: 60000 });
  await pending(f);
  const [entry] = (await f.broker.list("fixture")).requests;
  await f.broker.touch("fixture", entry.id, { client: "other" });
  const first = subscribe(f.hub, topic);
  const early = await first.next(listed);
  await delay(300);
  const late = subscribe(f.hub, topic);
  const cached = await late.next(listed);
  assert.equal(cached.revision, early.revision);
  assert.equal(
    cached.data.requests[0].interaction.at,
    early.data.requests[0].interaction.at,
  );
  assert.ok(cached.data.sampledAt - early.data.sampledAt >= 250);
  first.stop();
  late.stop();
});

test("a terminal notice and its clearing push frames", async (t) => {
  const f = await fixture(t, { sampleMs: 60000 });
  const tab = subscribe(f.hub, topic);
  await tab.next();
  f.broker.terminalNotice({
    id: "a".repeat(64),
    sessionId: "fixture",
    source: "claude",
    kind: "permission",
  });
  const shown = await tab.next(pushed, 1000);
  assert.deepEqual(shown.data.notice, { id: "a".repeat(64), reason: "terminal" });
  f.broker.clearNotice("fixture");
  const cleared = await tab.next(pushed, 1000);
  assert.equal(cleared.data.notice, undefined);
  tab.stop();
});

test("the startup sampler stops once startup is complete", async (t) => {
  const f = await fixture(t);
  const tab = subscribe(f.hub, topic);
  await tab.next();
  const screens = f.counts.screens;
  await until(() => f.counts.screens >= screens + 3);
  // Claude confirmed its launch: no screen capture runs on a timer any more.
  await f.startupDone();
  await delay(100);
  const settled = f.counts.screens;
  await delay(400);
  assert.equal(f.counts.screens, settled);
  tab.stop();
});

test("sampling goes on for the grace period after the receipt, then stops", async (t) => {
  const f = await fixture(t, { graceMs: 600 });
  const tab = subscribe(f.hub, topic);
  await tab.next();
  await f.startupDone();
  const written = Date.now();
  // Within the grace period a late startup dialog is still looked for on a timer.
  const confirmed = f.counts.screens;
  await until(() => f.counts.screens >= confirmed + 3, 500);
  assert.ok(Date.now() - written < 600);
  // Past the grace period (and one sample that may still run), nothing samples.
  await delay(Math.max(0, written + 700 - Date.now()));
  const settled = f.counts.screens;
  await delay(400);
  assert.equal(f.counts.screens, settled);
  tab.stop();
});

test("the planned grace period names 20 s", () => {
  assert.equal(STARTUP_GRACE_MS, 20000);
});

test("after startup, broker changes and native activity still push", async (t) => {
  const f = await fixture(t);
  await f.startupDone();
  const tab = subscribe(f.hub, topic);
  await tab.next();
  await pending(f);
  const created = await tab.next(listed, 1000);
  await f.broker.touch("fixture", created.data.requests[0].id, { client: "other" });
  const touched = await tab.next(pushed, 1000);
  assert.equal(touched.data.requests[0].interaction.client, "other");
  // Native activity reads the list again (the read looks at the screen once).
  const screens = f.counts.screens;
  f.services.chatEvents.publish("fixture", "native-activity");
  await until(() => f.counts.screens > screens, 1000);
  const settled = f.counts.screens;
  await delay(300);
  assert.equal(f.counts.screens, settled);
  tab.stop();
});

test("a user and a malformed id do not resolve", async (t) => {
  const f = await fixture(t);
  const frames = [];
  f.hub.subscribe({ role: "user" }, topic, undefined, (frame) => frames.push(frame));
  f.hub.subscribe({ role: "owner" }, "session.requests:../x", undefined, (frame) =>
    frames.push(frame),
  );
  assert.deepEqual(
    frames.map((frame) => frame.code),
    ["unknown-topic", "unknown-topic"],
  );
  assert.equal(f.counts.screens, 0);
});
