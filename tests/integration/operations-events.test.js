import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { NotificationService } from "../../server/features/notifications/notification-service.js";
import { AuditStore } from "../../server/features/audit/audit-store.js";
import { OperationsEvents } from "../../server/application/operations-events.js";
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
