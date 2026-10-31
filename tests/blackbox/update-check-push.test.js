import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { UpdateChecker } from "../../server/application/update-checker.js";
import { NotificationService } from "../../server/features/notifications/notification-service.js";
import { pushEvent } from "../../server/features/notifications/push-validation.js";
import { operationsRoutes } from "../../server/http/routes/operations.js";

// The notification service's own observations (persisted), with pushes recorded.
function notificationsIn(dataDir, sent) {
  const service = new NotificationService({ dataDir, send: async () => ({}) });
  return {
    service,
    observation: (key) => service.observation(key),
    observe: (key, value) => service.observe(key, value),
    notify: async (input) => {
      pushEvent(input);
      sent.push(input);
    },
  };
}

// The automatic check with a timer the test fires by hand.
async function automaticCheck(notifications, plan) {
  let pending;
  const checker = new UpdateChecker({
    releases: { channel: "https://example.com/channel/", check: async () => plan },
    notifications,
    logger: { warn() {} },
    random: () => 0,
    setTimer: (fn) => (pending = fn),
    clearTimer() {},
  });
  checker.start();
  pending();
  await checker.running;
  await checker.close();
}

test("a check a person started never pushes, and its version stays known", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-update-push-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const sent = [];
  const notifications = notificationsIn(dataDir, sent);
  let plan = { version: "2.13.0", upToDate: false };
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    operationsRoutes({
      operations: { releases: { check: async () => plan } },
      notifications,
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/operations/releases/check`;

  const response = await fetch(url, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).plan.version, "2.13.0");
  assert.deepEqual(sent, []);

  // After a restart, the automatic check finds the same version: still no push.
  await notifications.service.close();
  const restarted = notificationsIn(dataDir, sent);
  t.after(() => restarted.service.close());
  await automaticCheck(restarted, plan);
  assert.deepEqual(sent, []);

  // A newer version the automatic check finds pushes exactly once.
  plan = { version: "2.14.0", upToDate: false };
  await automaticCheck(restarted, plan);
  await automaticCheck(restarted, plan);
  assert.deepEqual(
    sent.map((notice) => [notice.kind, notice.label]),
    [["update-available", "2.14.0"]],
  );
});
