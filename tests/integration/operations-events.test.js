import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { NotificationService } from "../../server/features/notifications/notification-service.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { OperationsEvents } from "../../server/application/operations-events.js";
import { pushPayload } from "../../server/features/notifications/push-validation.js";
test("closed browser observes completion and every pipeline gate without replaying history on restart", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-event-test-"));
  const sent = [];
  const notifications = new NotificationService({
    dataDir,
    send: async (_sub, payload) => sent.push(payload),
  });
  const audit = new AuditStore({ dataDir });
  const key = createECDH("prime256v1");
  key.generateKeys();
  const { subscription: device } = await notifications.subscribe({
    deviceId: "phone",
    label: "Phone",
    subscription: {
      endpoint: "https://push.example.com/device",
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
  });
  let state = "idle";
  const session = { id: "session-one", tool: "codex", status: "running" };
  const run = {
    id: "run-one",
    status: "running",
    currentNodeId: "build",
    currentAttemptId: "attempt-one",
    nodes: [],
  };
  const inputs = {
    audit,
    notifications,
    sessions: { list: async () => [session] },
    activity: { read: async () => ({ state }) },
    pipelines: { store: { all: () => [run] } },
    intervalMs: 0,
  };
  let events = new OperationsEvents(inputs);
  t.after(async () => {
    await events.close();
    await notifications.close();
    audit.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  await events.poll();
  assert.equal(sent.length, 0);
  state = "working";
  await events.poll();
  state = "idle";
  await events.poll();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "session-completed");
  run.status = "awaiting-human";
  events.pipeline(run);
  run.status = "running";
  events.pipeline(run);
  run.status = "awaiting-human";
  events.pipeline(run);
  await new Promise(setImmediate);
  assert.equal(sent.filter((item) => item.kind === "pipeline-gate").length, 2);
  assert.notEqual(sent[1].eventId, sent[2].eventId);
  await events.close();
  events = new OperationsEvents(inputs);
  await events.poll();
  assert.equal(sent.length, 3);
  // A completed run notifies only devices that chose it; a failed one by default.
  run.status = "completed";
  events.pipeline(run);
  await new Promise(setImmediate);
  assert.equal(sent.length, 3);
  await notifications.setPreferences(device.id, {
    events: { "pipeline-completed": true },
  });
  run.status = "running";
  events.pipeline(run);
  run.status = "completed";
  events.pipeline(run);
  await new Promise(setImmediate);
  assert.equal(sent.at(-1).kind, "pipeline-completed");
  assert.equal(sent.at(-1).link, "/pipelines/runs/run-one");
  run.status = "running";
  events.pipeline(run);
  run.status = "failed";
  events.pipeline(run);
  await new Promise(setImmediate);
  assert.equal(sent.at(-1).kind, "pipeline-failed");
  assert.equal(audit.list().total, 6);
  assert.equal(JSON.stringify(audit.export()).includes("Phone"), false);
});

test("ended pipeline runs are audited with their own status action", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-event-test-"));
  const audit = new AuditStore({ dataDir });
  const notifications = {
    status: () => ({ subscriptions: [] }),
    observations: new Map(),
    observation(key) {
      return this.observations.get(key);
    },
    observe(key, value) {
      this.observations.set(key, value);
    },
    notify: async () => {},
  };
  const events = new OperationsEvents({
    audit,
    notifications,
    sessions: { list: async () => [] },
    pipelines: { store: { all: () => [] } },
    intervalMs: 0,
  });
  t.after(async () => {
    await events.close();
    audit.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  for (const status of ["completed", "failed", "cancelled"]) {
    const run = { id: `run-${status}`, status: "running", nodes: [] };
    events.pipeline(run);
    run.status = status;
    events.pipeline(run);
  }
  assert.deepEqual(
    audit
      .export()
      .map(({ action, outcome, resourceId }) => [action, outcome, resourceId]),
    [
      ["pipeline.completed", "success", "run-completed"],
      ["pipeline.failed", "failure", "run-failed"],
      ["pipeline.cancelled", "success", "run-cancelled"],
    ],
  );
});

function waitingFixture(t) {
  const sent = [];
  let subscriptions = [{}];
  const notifications = {
    status: () => ({ subscriptions }),
    observations: new Map(),
    observation(key) {
      return this.observations.get(key);
    },
    observe(key, value) {
      this.observations.set(key, value);
    },
    notify: async (value) => sent.push(value),
  };
  const ctx = {
    sent,
    clock: 0,
    reads: 0,
    activity: { state: "working", source: "hook" },
    session: { id: "session-wait", tool: "claude", status: "running" },
    devices: (value) => {
      subscriptions = value ? [{}] : [];
    },
    kinds: () => sent.map((item) => item.kind),
  };
  const audit = { append() {} };
  ctx.events = new OperationsEvents({
    audit,
    notifications,
    sessions: { list: async () => [ctx.session] },
    activity: {
      read: async () => {
        ctx.reads++;
        return ctx.activity;
      },
    },
    pipelines: { store: { all: () => [] } },
    intervalMs: 0,
    now: () => ctx.clock,
  });
  ctx.request = () =>
    ctx.events.emit({
      action: "request.created",
      resourceType: "request",
      resourceId: `r${ctx.clock}`,
      sessionId: ctx.session.id,
      kind: "permission",
      source: "system",
      outcome: "success",
      details: { kind: "permission" },
    });
  // One poll every 2.5 seconds, as in production.
  ctx.poll = async (state, source = "hook") => {
    if (state) ctx.activity = { state, source };
    ctx.clock += 2500;
    await ctx.events.poll();
  };
  t.after(() => ctx.events.close());
  return ctx;
}

test("a reported wait notifies once after a short grace, unless a request already did", async (t) => {
  const ctx = waitingFixture(t);
  await ctx.poll();
  await ctx.poll("waiting");
  assert.deepEqual(ctx.kinds(), [], "a request for the same wait may still arrive");
  await ctx.poll();
  await ctx.poll();
  assert.deepEqual(ctx.kinds(), ["session-waiting"]);
  assert.deepEqual(pushPayload(ctx.sent[0]), {
    kind: "session-waiting",
    eventId: ctx.sent[0].eventId,
    sessionId: "session-wait",
  });
  // A native dialog the owner opened in the terminal never notifies.
  await ctx.poll("working");
  await ctx.poll("waiting", "native-terminal");
  await ctx.poll();
  await ctx.poll();
  assert.deepEqual(ctx.kinds(), ["session-waiting"]);
  // Codex reports waitingOnApproval and its approval request almost together, in
  // either order: only the approval notifies.
  for (const requestFirst of [true, false]) {
    await ctx.poll("working");
    if (requestFirst) ctx.request();
    await ctx.poll("waiting");
    if (!requestFirst) ctx.request();
    await ctx.poll();
    await ctx.poll();
  }
  assert.deepEqual(ctx.kinds(), ["session-waiting", "permission", "permission"]);
  // The next wait after the session moved on notifies again, with a new event ID.
  await ctx.poll("working");
  await ctx.poll("waiting");
  await ctx.poll();
  await ctx.poll();
  assert.deepEqual(ctx.kinds(), [
    "session-waiting",
    "permission",
    "permission",
    "session-waiting",
  ]);
  assert.notEqual(ctx.sent[0].eventId, ctx.sent[3].eventId);
});

test("a remembered request is forgotten once its session stops waiting, even without devices", async (t) => {
  const ctx = waitingFixture(t);
  ctx.devices(false);
  await ctx.poll("working");
  assert.equal(ctx.reads, 0, "without devices and requests nothing reads the terminal");
  ctx.request();
  await ctx.poll("waiting", "request");
  assert.equal(ctx.events.requested.has(ctx.session.id), true);
  await ctx.poll("idle");
  assert.equal(ctx.events.requested.has(ctx.session.id), false);
  const reads = ctx.reads;
  await ctx.poll();
  assert.equal(ctx.reads, reads);
  // A stopped session forgets its request as well.
  ctx.request();
  ctx.session.status = "stopped";
  await ctx.poll();
  assert.equal(ctx.events.requested.size, 0);
  // Devices added during a later wait get its push.
  ctx.session.status = "running";
  ctx.devices(true);
  await ctx.poll("working");
  await ctx.poll("waiting");
  await ctx.poll();
  await ctx.poll();
  // The request push reads its session first, so it follows the ended session.
  assert.deepEqual(ctx.kinds(), [
    "permission",
    "session-ended",
    "permission",
    "session-waiting",
  ]);
});
