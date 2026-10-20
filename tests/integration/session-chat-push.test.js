import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { NotificationService } from "../../server/features/notifications/notification-service.js";
import { OperationsEvents } from "../../server/application/operations-events.js";

// Session chat pushes: "Response ready" when a coding CLI finishes its turn and the
// waiting kinds, triggered by the CLI's own pushed activity reports.

const noon = Date.parse("2026-10-20T12:00:00Z");

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-chat-push-"));
  const sent = [];
  const clock = { now: () => noon };
  const notifications = new NotificationService({
    dataDir,
    clock,
    send: async (_subscription, payload) => sent.push(payload),
  });
  const key = createECDH("prime256v1");
  key.generateKeys();
  const { subscription: device } = await notifications.subscribe({
    deviceId: "phone",
    label: "Phone",
    timeZone: "UTC",
    subscription: {
      endpoint: "https://push.example.com/device",
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
  });
  const ctx = {
    sent,
    device,
    notifications,
    state: "idle",
    session: { id: "chat-one", tool: "claude", status: "running", name: "api" },
  };
  ctx.events = new OperationsEvents({
    audit: { append() {} },
    notifications,
    sessions: {
      list: async () => [ctx.session],
      get: async () => ctx.session,
    },
    activity: { read: async () => ({ state: ctx.state, source: "hook" }) },
    pipelines: { store: { all: () => [] } },
    intervalMs: 0,
  });
  // What the broker's onNative hands over for an authenticated activity push.
  ctx.push = async (event, state) => {
    if (state) ctx.state = state;
    ctx.events.nativeActivity(ctx.session.id, event);
    await ctx.events.again;
    await Promise.allSettled([...notifications.active]);
  };
  ctx.kinds = () => sent.map((payload) => payload.kind);
  t.after(async () => {
    await ctx.events.close();
    await notifications.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await ctx.events.poll();
  return ctx;
}

test("a turn that starts and ends between two polls still notifies once, with a deep link", async (t) => {
  const ctx = await fixture(t);
  // The hook's UserPromptSubmit push arrives, but the turn is over before any read.
  ctx.state = "idle";
  await ctx.push("UserPromptSubmit");
  assert.deepEqual(ctx.kinds(), ["session-completed"]);
  assert.equal(ctx.sent[0].link, "/sessions/chat-one/chat");
  // The Stop push of the same turn and later polls do not repeat it.
  await ctx.push("Stop", "idle");
  await ctx.events.poll();
  assert.deepEqual(ctx.kinds(), ["session-completed"]);
  // Codex's turn events count the same way; a new turn notifies with a new event.
  await ctx.push("turn/started", "working");
  assert.deepEqual(ctx.kinds(), ["session-completed"]);
  await ctx.push("turn/completed", "idle");
  assert.deepEqual(ctx.kinds(), ["session-completed", "session-completed"]);
  assert.notEqual(ctx.sent[0].eventId, ctx.sent[1].eventId);
  // An activity push that starts no turn (OpenCode's status) only triggers the read.
  await ctx.push("session.status", "idle");
  assert.equal(ctx.sent.length, 2);
});

test("an open chat, a device's choice and its quiet hours hold the finished push back", async (t) => {
  const ctx = await fixture(t);
  // The owner looks at this session's chat: nothing is pushed.
  ctx.notifications.reportPresence(`/sessions/${ctx.session.id}`);
  await ctx.push("UserPromptSubmit", "working");
  await ctx.push("Stop", "idle");
  assert.deepEqual(ctx.kinds(), []);
  ctx.notifications.presence.views.clear();
  // A device that switched "Response ready" off receives nothing either.
  await ctx.notifications.setPreferences(ctx.device.id, {
    events: { "session-completed": false },
  });
  await ctx.push("UserPromptSubmit", "working");
  await ctx.push("Stop", "idle");
  assert.deepEqual(ctx.kinds(), []);
  // Quiet hours hold a finished turn, but let an approval through when allowed.
  await ctx.notifications.setPreferences(ctx.device.id, {
    events: { "session-completed": true },
    quiet: { enabled: true, from: "10:00", to: "14:00", blockingThrough: true },
  });
  await ctx.push("UserPromptSubmit", "working");
  await ctx.push("Stop", "idle");
  assert.deepEqual(ctx.kinds(), []);
  ctx.events.emit({
    action: "request.created",
    resourceType: "request",
    resourceId: "request-one",
    sessionId: ctx.session.id,
    kind: "permission",
    source: "system",
    outcome: "success",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Promise.allSettled([...ctx.notifications.active]);
  assert.deepEqual(ctx.kinds(), ["permission"]);
  assert.equal(ctx.sent[0].link, "/inbox/approval/request-one");
});

test("without registered devices a pushed turn start changes nothing", async (t) => {
  const ctx = await fixture(t);
  const before = ctx.notifications.observation(`activity:${ctx.session.id}`);
  await ctx.notifications.unsubscribe(ctx.device.id);
  await ctx.push("UserPromptSubmit");
  assert.equal(ctx.notifications.observation(`activity:${ctx.session.id}`), before);
  assert.deepEqual(ctx.kinds(), []);
});

test("the broker hands a CLI's activity push to the session push events", async (t) => {
  const { applicationFixture } = await import("../helpers/application.js");
  const { application } = await applicationFixture(t);
  const seen = [];
  application.operationsEvents.nativeActivity = (...args) => seen.push(args);
  application.requests.onNative("session-a", { type: "activity", event: "Stop" });
  application.requests.onNative("session-a", { type: "stream-end", runId: "run" });
  assert.deepEqual(seen, [["session-a", "Stop"]]);
});
