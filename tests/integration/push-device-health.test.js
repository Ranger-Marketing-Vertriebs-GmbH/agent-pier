import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { NotificationService } from "../../server/features/notifications/notification-service.js";
import { attemptsPerDevice } from "../../server/features/notifications/push-delivery-log.js";
import { auditEvent } from "../../server/features/audit/audit-schema.js";

const subscription = (endpoint = "https://push.example.com/send/fixture") => {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
};

async function fixture(t, send = async () => ({ statusCode: 201 })) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-push-health-"));
  const audited = [],
    logged = [];
  let now = Date.parse("2026-10-30T10:00:00Z");
  const service = new NotificationService({
    dataDir,
    send: (...args) => send(...args),
    clock: { now: () => now },
    // The real schema filters each event, as the audit store does.
    audit: { append: (event) => audited.push(auditEvent(event)) },
    logger: { warn: (line) => logged.push(line) },
  });
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return {
    service,
    audited,
    logged,
    tick: (ms) => (now += ms),
  };
}

test("an expired device is removed with an audit entry and a log line, never its endpoint", async (t) => {
  let answer = { statusCode: 201 };
  const f = await fixture(t, async () => {
    if (answer.statusCode >= 400) throw Object.assign(Error("gone"), answer);
    return answer;
  });
  const secret = subscription("https://push.example.com/send/secret-endpoint");
  const { subscription: device } = await f.service.subscribe({
    deviceId: "device-one",
    label: "Phone",
    subscription: secret,
  });
  await f.service.notify({ kind: "question", sessionId: "s1", eventId: "e1" });
  let status = f.service.status();
  assert.equal(status.subscriptions[0].lastDelivery.status, "sent");
  assert.deepEqual(status.health, { devices: 1, lost: false, failing: false });

  answer = { statusCode: 410 };
  await f.service.notify({ kind: "question", sessionId: "s1", eventId: "e2" });
  status = f.service.status();
  assert.equal(status.subscriptions.length, 0);
  assert.equal(status.health.lost, true);
  assert.equal(status.health.removed.label, "Phone");
  assert.equal(status.health.removed.reason, "expired");
  assert.deepEqual(
    f.audited.map((event) => [event.action, event.resourceId, event.details]),
    [["notification.unsubscribed", device.id, { reason: "expired", statusCode: 410 }]],
  );
  assert.deepEqual(f.logged, ["AgentPier removed a push device (expired, HTTP 410)."]);
  const evidence = JSON.stringify([f.audited, f.logged, status]);
  for (const value of [secret.endpoint, secret.keys.auth, secret.keys.p256dh])
    assert.equal(evidence.includes(value), false);
});

test("every device failing raises the warning; a delivery that works clears it", async (t) => {
  let fail = true;
  const f = await fixture(t, async () => {
    if (fail) throw Object.assign(Error("refused"), { statusCode: 403 });
    return { statusCode: 201 };
  });
  for (const deviceId of ["device-one", "device-two"])
    await f.service.subscribe({
      deviceId,
      label: deviceId,
      subscription: subscription(),
    });
  await f.service.notify({ kind: "question", sessionId: "s1", eventId: "e1" });
  let status = f.service.status();
  assert.equal(status.health.failing, true);
  for (const device of status.subscriptions) {
    assert.equal(device.lastDelivery.status, "failed");
    assert.equal(device.lastDelivery.statusCode, 403);
    assert.equal(device.lastDelivery.kind, "question");
    assert.equal(typeof device.lastDelivery.failure, "string");
  }
  fail = false;
  await f.service.test(status.subscriptions[0].id);
  status = f.service.status();
  assert.equal(status.health.failing, false);
  assert.equal(status.subscriptions[0].lastDelivery.status, "sent");
  assert.equal(status.subscriptions[0].lastDelivery.failure, undefined);
});

test("the delivery log keeps a bounded number of attempts per device and drops old ones", async (t) => {
  const f = await fixture(t);
  const { subscription: device } = await f.service.subscribe({
    deviceId: "device-one",
    label: "Phone",
    subscription: subscription(),
  });
  for (let index = 0; index < attemptsPerDevice + 5; index++)
    await f.service.notify({ kind: "question", sessionId: "s1", eventId: `e${index}` });
  const count = () =>
    f.service.db
      .prepare("SELECT COUNT(*) AS count FROM delivery_log WHERE subscription_id=?")
      .get(device.id).count;
  assert.equal(count(), attemptsPerDevice);
  f.tick(31 * 24 * 60 * 60 * 1000);
  await f.service.test(device.id);
  assert.equal(count(), 1);
});

test("sign-out and a remote sign-out are audited; unregistering on purpose is not a loss", async (t) => {
  const f = await fixture(t);
  await f.service.subscribe({
    deviceId: "device-one",
    label: "Laptop",
    subscription: subscription(),
  });
  f.service.forgetDevice("device-one", { userId: null });
  assert.equal(f.service.status().health.removed.reason, "signed-out");
  assert.equal(f.service.status().health.lost, true);
  await f.service.subscribe(
    { deviceId: "device-two", label: "User phone", subscription: subscription() },
    { userId: "user-one" },
  );
  f.service.forgetDevice("device-two", { userId: "user-two", others: true });
  f.service.forgetUser("user-one");
  assert.deepEqual(
    f.audited.map((event) => event.details.reason),
    ["signed-out", "signed-in-elsewhere"],
  );
  const { subscription: own } = await f.service.subscribe({
    deviceId: "device-three",
    label: "Desk",
    subscription: subscription(),
  });
  await f.service.unsubscribe(own.id);
  const health = f.service.status().health;
  assert.equal(health.lost, false);
  assert.equal(health.removed, undefined);
  // A user's own removal stays theirs: the owner's status never names it.
  assert.equal(f.service.status({ userId: "user-one" }).health.lost, true);
});

test("a renewed subscription keeps the device; an unknown device is not found", async (t) => {
  const f = await fixture(t);
  const first = subscription("https://push.example.com/send/first");
  const { subscription: device } = await f.service.subscribe({
    deviceId: "device-one",
    label: "Phone",
    subscription: first,
  });
  await f.service.setPreferences(device.id, { level: "preview" });
  const same = await f.service.renew({ deviceId: "device-one", subscription: first });
  assert.equal(same.renewed, false);
  const next = await f.service.renew({
    deviceId: "device-one",
    subscription: subscription("https://push.example.com/send/second"),
  });
  assert.equal(next.renewed, true);
  assert.equal(next.subscription.id, device.id);
  assert.equal(next.subscription.label, "Phone");
  assert.equal(next.subscription.preferences.level, "preview");
  const secret = f.service.db
    .prepare("SELECT secret FROM subscriptions WHERE id=?")
    .get(device.id).secret;
  assert.match(secret, /second/);
  await assert.rejects(
    f.service.renew({ deviceId: "device-two", subscription: first }),
    (error) => error.status === 404,
  );
  // Another person's device is not theirs to renew.
  await assert.rejects(
    f.service.renew(
      { deviceId: "device-one", subscription: first },
      { userId: "user-one" },
    ),
    (error) => error.status === 404,
  );
});

test("a release without the delivery log still writes deliveries after a rollback", async (t) => {
  const f = await fixture(t);
  await f.service.subscribe({
    deviceId: "device-one",
    label: "Phone",
    subscription: subscription(),
  });
  await f.service.notify({ kind: "question", sessionId: "s1", eventId: "e1" });
  // The statement releases before the log used, unchanged.
  f.service.db
    .prepare("INSERT OR IGNORE INTO deliveries VALUES(?,?,'claimed')")
    .run("x", "y");
  assert.equal(f.service.db.prepare("PRAGMA user_version").get().user_version, 2);
});

test("the workspace state's owner health matches the owner's status", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(f.service.ownerHealth(), f.service.status().health);
  await f.service.subscribe({
    deviceId: "device-one",
    label: "Phone",
    subscription: subscription(),
  });
  assert.deepEqual(f.service.ownerHealth(), { devices: 1, lost: false, failing: false });
});
