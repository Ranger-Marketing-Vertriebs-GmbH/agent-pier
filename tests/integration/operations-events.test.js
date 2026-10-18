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
  await notifications.subscribe({
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
  run.status = "completed";
  events.pipeline(run);
  await new Promise(setImmediate);
  assert.equal(sent.at(-1).kind, "pipeline-ended");
  assert.equal(audit.list().total, 4);
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

test("a reported wait notifies once, unless an approval or question already did", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-event-test-"));
  const audit = new AuditStore({ dataDir });
  const sent = [];
  const notifications = {
    status: () => ({ subscriptions: [{}] }),
    observations: new Map(),
    observation(key) {
      return this.observations.get(key);
    },
    observe(key, value) {
      this.observations.set(key, value);
    },
    notify: async (value) => sent.push(value),
  };
  let activity = { state: "working", source: "hook" };
  const session = { id: "session-wait", tool: "claude", status: "running" };
  const events = new OperationsEvents({
    audit,
    notifications,
    sessions: { list: async () => [session] },
    activity: { read: async () => activity },
    pipelines: { store: { all: () => [] } },
    intervalMs: 0,
  });
  t.after(async () => {
    await events.close();
    audit.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const kinds = () => sent.map((item) => item.kind);
  await events.poll();
  activity = { state: "waiting", source: "hook" };
  await events.poll();
  await events.poll();
  assert.deepEqual(kinds(), ["session-waiting"]);
  assert.deepEqual(pushPayload(sent[0]), {
    kind: "session-waiting",
    eventId: sent[0].eventId,
    sessionId: "session-wait",
  });
  // A native dialog the owner opened in the terminal never notifies.
  activity = { state: "working", source: "hook" };
  await events.poll();
  activity = { state: "waiting", source: "native-terminal" };
  await events.poll();
  assert.deepEqual(kinds(), ["session-waiting"]);
  // An AgentPier request already sent its own push for this wait.
  activity = { state: "working", source: "hook" };
  await events.poll();
  events.emit({
    action: "request.created",
    resourceType: "request",
    resourceId: "r1",
    sessionId: session.id,
    kind: "permission",
    source: "system",
    outcome: "success",
    details: { kind: "permission" },
  });
  activity = { state: "waiting", source: "hook" };
  await events.poll();
  assert.deepEqual(kinds(), ["session-waiting", "permission"]);
  // The next wait after the session moved on notifies again, with a new event ID.
  activity = { state: "working", source: "hook" };
  await events.poll();
  activity = { state: "waiting", source: "hook" };
  await events.poll();
  assert.deepEqual(kinds(), ["session-waiting", "permission", "session-waiting"]);
  assert.notEqual(sent[0].eventId, sent[2].eventId);
});
