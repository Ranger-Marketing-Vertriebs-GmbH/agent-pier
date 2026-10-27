import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { NotificationService } from "../../server/features/notifications/notification-service.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import {
  OperationsEvents,
  agentRequestHoldMs,
} from "../../server/application/operations-events.js";
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
  // The sessions an agent controls (AgentCodingSessions.controls).
  ctx.controlled = new Set();
  // The broker's open requests (RequestBroker.listAll).
  ctx.pending = [];
  ctx.events = new OperationsEvents({
    requests: { listAll: () => ctx.pending },
    assistants: {
      workflows: {
        sessions: { controls: (id) => ctx.controlled.has(id), requestEvent() {} },
      },
    },
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
  ctx.request = (id = `r${ctx.clock}`) =>
    ctx.events.emit({
      action: "request.created",
      resourceType: "request",
      resourceId: id,
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

const flush = () => new Promise(setImmediate);
const answered = (ctx, id, action = "request.answered") =>
  ctx.events.emit({
    action,
    resourceType: "request",
    resourceId: id,
    sessionId: ctx.session.id,
    kind: "permission",
    source: "user",
    outcome: "success",
    details: { kind: "permission" },
  });

test("an owner session's request notifies at once, as before", async (t) => {
  const ctx = waitingFixture(t);
  ctx.request("owner-prompt");
  await flush();
  assert.deepEqual(
    ctx.sent.map(({ kind, eventId }) => [kind, eventId]),
    [["permission", "owner-prompt"]],
  );
  assert.equal(ctx.events.held.size, 0);
});

test("a controlled session's request is held until the agent escalates it", async (t) => {
  const ctx = waitingFixture(t);
  ctx.controlled.add(ctx.session.id);
  ctx.request("held-prompt");
  await flush();
  assert.deepEqual(ctx.sent, []);
  assert.equal(ctx.events.held.has("held-prompt"), true);
  await ctx.events.releaseRequest("held-prompt");
  assert.deepEqual(
    ctx.sent.map(({ kind, eventId }) => [kind, eventId]),
    [["permission", "held-prompt"]],
  );
  assert.equal(ctx.events.held.size, 0);
  // Released once: a second release and later polls send nothing more.
  await ctx.events.releaseRequest("held-prompt");
  await ctx.events.releaseRequest("unknown-prompt");
  ctx.clock += agentRequestHoldMs;
  await ctx.poll();
  assert.equal(ctx.sent.length, 1);
});

test("a held request notifies once after fifteen minutes", async (t) => {
  assert.equal(agentRequestHoldMs, 15 * 60 * 1000);
  const ctx = waitingFixture(t);
  ctx.controlled.add(ctx.session.id);
  await ctx.poll("working");
  ctx.request("slow-prompt");
  await flush();
  ctx.clock += agentRequestHoldMs - 2501;
  await ctx.poll();
  assert.deepEqual(ctx.sent, [], "the hold has not run out yet");
  await ctx.poll();
  assert.deepEqual(
    ctx.sent.map(({ kind, eventId }) => [kind, eventId]),
    [["permission", "slow-prompt"]],
  );
  await ctx.poll();
  await ctx.events.releaseRequest("slow-prompt");
  assert.equal(ctx.sent.length, 1);
});

test("revoking control releases a held request on the next collect", async (t) => {
  const ctx = waitingFixture(t);
  ctx.controlled.add(ctx.session.id);
  await ctx.poll("working");
  ctx.request("revoked-prompt");
  await flush();
  await ctx.poll();
  assert.deepEqual(ctx.sent, []);
  ctx.controlled.delete(ctx.session.id);
  await ctx.poll();
  assert.deepEqual(
    ctx.sent.map(({ kind, eventId }) => [kind, eventId]),
    [["permission", "revoked-prompt"]],
  );
  assert.equal(ctx.events.held.size, 0);
});

test("an answered or handed-off request is never pushed", async (t) => {
  const ctx = waitingFixture(t);
  ctx.controlled.add(ctx.session.id);
  await ctx.poll("working");
  ctx.request("agent-answered");
  ctx.request("handed-off");
  await flush();
  answered(ctx, "agent-answered");
  answered(ctx, "handed-off", "request.handed-off");
  assert.equal(ctx.events.held.size, 0);
  ctx.clock += agentRequestHoldMs;
  await ctx.poll();
  ctx.controlled.delete(ctx.session.id);
  await ctx.poll();
  await ctx.events.releaseRequest("agent-answered");
  assert.deepEqual(ctx.sent, []);
});

test("a controlled session sends no completion or wait push, but its end", async (t) => {
  const ctx = waitingFixture(t);
  ctx.controlled.add(ctx.session.id);
  await ctx.poll("working");
  await ctx.poll("idle");
  await ctx.poll("working");
  await ctx.poll("waiting");
  await ctx.poll();
  await ctx.poll();
  assert.deepEqual(ctx.kinds(), []);
  ctx.session.status = "stopped";
  await ctx.poll();
  assert.deepEqual(ctx.kinds(), ["session-ended"]);
  // Once control ends, the session notifies as an owner session again.
  ctx.controlled.delete(ctx.session.id);
  ctx.session.status = "running";
  await ctx.poll("working");
  await ctx.poll("idle");
  assert.deepEqual(ctx.kinds(), ["session-ended", "session-completed"]);
});

const pending = (ctx, id) => ({
  id,
  sessionId: ctx.session.id,
  kind: "permission",
  status: "pending",
});

test("an open request of a controlled session that was never announced is held too", async (t) => {
  // After a restart the broker does not announce a request again.
  const ctx = waitingFixture(t);
  ctx.controlled.add(ctx.session.id);
  ctx.pending = [
    pending(ctx, "restored"),
    { ...pending(ctx, "busy"), status: "responding" },
  ];
  await ctx.poll("waiting", "request");
  assert.deepEqual(ctx.sent, []);
  assert.deepEqual([...ctx.events.held.keys()], ["restored"]);
  ctx.clock += agentRequestHoldMs;
  await ctx.poll();
  await ctx.poll();
  assert.deepEqual(
    ctx.sent.map(({ kind, eventId }) => [kind, eventId]),
    [["permission", "restored"]],
  );
  // Revoking control releases a restored request at once.
  ctx.pending.push(pending(ctx, "restored-two"));
  await ctx.poll();
  assert.equal(ctx.events.held.has("restored-two"), true);
  ctx.controlled.delete(ctx.session.id);
  await ctx.poll();
  assert.deepEqual(
    ctx.sent.map(({ eventId }) => eventId),
    ["restored", "restored-two"],
  );
  // An owner session's open requests are not reconciled.
  ctx.pending.push(pending(ctx, "owner-open"));
  await ctx.poll();
  assert.equal(ctx.events.held.size, 0);
});

test("a request republished after its socket reconnected is still pushed once", async (t) => {
  const ctx = waitingFixture(t);
  ctx.controlled.add(ctx.session.id);
  await ctx.poll("waiting", "request");
  ctx.request("reconnected");
  ctx.pending = [pending(ctx, "reconnected")];
  await flush();
  // The socket closes: the broker expires the request, then republishes it with
  // the same id and no new request.created.
  ctx.pending = [];
  answered(ctx, "reconnected", "request.expired");
  assert.equal(ctx.events.held.size, 0);
  await ctx.poll();
  ctx.pending = [pending(ctx, "reconnected")];
  await ctx.poll();
  assert.equal(ctx.events.held.has("reconnected"), true);
  ctx.clock += agentRequestHoldMs;
  await ctx.poll();
  await ctx.poll();
  assert.deepEqual(
    ctx.sent.map(({ kind, eventId }) => [kind, eventId]),
    [["permission", "reconnected"]],
  );
});

test("an expired request is forgotten without a push", async (t) => {
  const ctx = waitingFixture(t);
  ctx.controlled.add(ctx.session.id);
  await ctx.poll("working");
  ctx.request("expired");
  await flush();
  answered(ctx, "expired", "request.expired");
  assert.equal(ctx.events.held.size, 0);
  ctx.clock += agentRequestHoldMs;
  await ctx.poll();
  ctx.controlled.delete(ctx.session.id);
  await ctx.poll();
  assert.deepEqual(ctx.sent, []);
});

test("a held request is dropped once its session stops running", async (t) => {
  const ctx = waitingFixture(t);
  ctx.controlled.add(ctx.session.id);
  await ctx.poll("working");
  ctx.request("stopped-prompt");
  await flush();
  ctx.session.status = "stopped";
  await ctx.poll();
  assert.equal(ctx.events.held.size, 0);
  ctx.clock += agentRequestHoldMs;
  ctx.controlled.delete(ctx.session.id);
  await ctx.poll();
  assert.deepEqual(ctx.kinds(), ["session-ended"]);
});
