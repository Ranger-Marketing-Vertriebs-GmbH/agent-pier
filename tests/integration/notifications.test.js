import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
const module =
  await import("../../server/features/notifications/notification-service.js").catch(
    () => ({}),
  );
const subscription = () => {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint: "https://push.example.com/send/fixture",
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
};
async function fixture(t, send = async () => ({ statusCode: 201 })) {
  assert.equal(typeof module.NotificationService, "function");
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-notifications-"));
  let service = new module.NotificationService({ dataDir, send });
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return {
    get service() {
      return service;
    },
    async reopen() {
      await service.close();
      service = new module.NotificationService({ dataDir, send });
    },
  };
}
test("push device rotation persists keys privately and public summaries omit subscription credentials", async (t) => {
  const f = await fixture(t),
    secret = subscription();
  const first = await f.service.subscribe({
    deviceId: "device-one",
    label: "My phone",
    subscription: secret,
  });
  const publicKey = f.service.status().publicKey;
  await f.reopen();
  const next = await f.service.subscribe({
    deviceId: "device-one",
    label: "Phone",
    subscription: { ...secret, endpoint: "https://push.example.com/send/rotated" },
  });
  assert.equal(next.subscription.id, first.subscription.id);
  const status = f.service.status();
  assert.equal(status.publicKey, publicKey);
  assert.equal(status.subscriptions.length, 1);
  for (const value of [secret.endpoint, secret.keys.auth, secret.keys.p256dh, "rotated"])
    assert.equal(JSON.stringify(status).includes(value), false);
  await f.service.unsubscribe(first.subscription.id);
  assert.equal(f.service.status().subscriptions.length, 0);
});
test("push occurrences deliver once across concurrent calls and restart without task content", async (t) => {
  const sent = [],
    f = await fixture(t, async (sub, payload) => {
      sent.push({ sub, payload });
      return { statusCode: 201 };
    });
  await f.service.subscribe({
    deviceId: "device-one",
    label: "Phone",
    subscription: subscription(),
  });
  const event = {
    kind: "question",
    sessionId: "session-one",
    eventId: "request-one",
    text: "fixture-sensitive",
    command: "fixture-sensitive",
  };
  await Promise.all([f.service.notify(event), f.service.notify(event)]);
  await f.reopen();
  await f.service.notify(event);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].payload, {
    kind: "question",
    sessionId: "session-one",
    eventId: "request-one",
  });
  assert.equal(JSON.stringify(sent[0].payload).includes("fixture-sensitive"), false);
});
test("push expiration removes only the failed device and transport errors do not fail native events", async (t) => {
  let fail = false;
  const f = await fixture(t, async () => {
    if (fail)
      throw Object.assign(Error("fixture-secret-provider-response"), { statusCode: 410 });
    throw Error("fixture-secret-network");
  });
  const { subscription: row } = await f.service.subscribe({
    deviceId: "device-one",
    label: "Phone",
    subscription: subscription(),
  });
  const result = await f.service.test(row.id);
  assert.equal(result.sent, false);
  assert.equal(JSON.stringify(result).includes("fixture-secret"), false);
  fail = true;
  await f.service.notify({
    kind: "session-ended",
    sessionId: "s-one",
    eventId: "end-one",
  });
  assert.equal(f.service.status().subscriptions.length, 0);
});
test("invalid private endpoints and malformed keys fail before subscription persistence", async (t) => {
  const f = await fixture(t),
    valid = subscription();
  for (const endpoint of [
    "http://push.example.com/send",
    "https://127.0.0.1/push",
    "https://[::1]/push",
    "https://localhost/push",
    "https://user:pass@push.example.com/push",
    "https://push.example.com:444/push",
  ])
    await assert.rejects(
      f.service.subscribe({
        deviceId: "device-one",
        label: "Phone",
        subscription: { ...valid, endpoint },
      }),
    );
  await assert.rejects(
    f.service.subscribe({
      deviceId: "device-one",
      label: "Phone",
      subscription: { ...valid, keys: { p256dh: "bad", auth: "bad" } },
    }),
  );
  assert.equal(f.service.status().subscriptions.length, 0);
});
test("a failed old push cannot delete a rotated device subscription", async (t) => {
  let rejectSend;
  const f = await fixture(
    t,
    () =>
      new Promise((_resolve, reject) => {
        rejectSend = reject;
      }),
  );
  const input = { deviceId: "device-one", label: "Phone", subscription: subscription() };
  const { subscription: row } = await f.service.subscribe(input);
  const pending = f.service.test(row.id);
  await new Promise(setImmediate);
  await f.service.subscribe({ ...input, subscription: subscription() });
  rejectSend(Object.assign(Error("gone"), { statusCode: 410 }));
  await pending;
  assert.equal(f.service.status().subscriptions.length, 1);
});
test("push concurrency is bounded globally and shutdown discards queued sends", async (t) => {
  let active = 0,
    peak = 0,
    calls = 0;
  const pending = [];
  const send = () => {
    calls++;
    active++;
    peak = Math.max(peak, active);
    return new Promise((resolve) =>
      pending.push(() => {
        active--;
        resolve();
      }),
    );
  };
  send.close = () => pending.splice(0).forEach((resolve) => resolve());
  const f = await fixture(t, send);
  await f.service.subscribe({
    deviceId: "device-one",
    label: "Phone",
    subscription: subscription(),
  });
  const work = Array.from({ length: 12 }, (_, i) =>
    f.service.notify({ kind: "question", eventId: `event-${i}`, sessionId: "s-one" }),
  );
  await new Promise(setImmediate);
  assert.ok(peak <= 4, `concurrent sends: ${peak}`);
  await f.service.close();
  await Promise.all(work);
  assert.ok(calls <= 4);
});
