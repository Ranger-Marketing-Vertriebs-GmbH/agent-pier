import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import {
  NotificationService,
  pushDefaultsKey,
} from "../../server/features/notifications/notification-service.js";
import { informationalKinds } from "../../server/features/notifications/push-preferences.js";

// Push defaults 2 (AGENTPIER-298): devices from before the update stop getting
// informational pushes once; what a person switches on again afterwards stays on.

const subscription = (name) => {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    endpoint: `https://push.example.com/send/${name}`,
    keys: {
      p256dh: key.getPublicKey().toString("base64url"),
      auth: randomBytes(16).toString("base64url"),
    },
  };
};

// Every event as the defaults before AGENTPIER-298 stored it on a new device.
const oldDefaults = {
  question: true,
  permission: true,
  "session-waiting": true,
  "pipeline-gate": true,
  "agent-approval": true,
  "session-completed": true,
  "session-ended": true,
  "pipeline-completed": false,
  "pipeline-failed": true,
  "agent-checkin": true,
  "agent-routine": true,
  "agent-hook-throttled": true,
  "session-limited": true,
  "session-resume-failed": true,
  "update-available": true,
  "update-failed": true,
  telegram: false,
};

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-push-defaults-"));
  const sent = [];
  const send = async (secret, payload) => {
    sent.push({ endpoint: secret.endpoint, payload });
    return { statusCode: 201 };
  };
  let service = new NotificationService({ dataDir, send });
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const add = async (deviceId) =>
    (
      await service.subscribe({
        deviceId,
        label: deviceId,
        subscription: subscription(deviceId),
      })
    ).subscription;
  return {
    sent,
    add,
    get service() {
      return service;
    },
    async reopen() {
      await service.close();
      service = new NotificationService({ dataDir, send });
    },
    /** The data as a release before AGENTPIER-298 left it: old defaults, no marker. */
    asOlderRelease() {
      for (const row of service.db.prepare("SELECT id,public FROM subscriptions").all()) {
        const summary = JSON.parse(row.public);
        summary.preferences.events = { ...oldDefaults };
        service.db
          .prepare("UPDATE subscriptions SET public=? WHERE id=?")
          .run(JSON.stringify(summary), row.id);
      }
      service.db.prepare("DELETE FROM settings WHERE key=?").run(pushDefaultsKey);
    },
    stored(id) {
      const row = service.db
        .prepare("SELECT public FROM subscriptions WHERE id=?")
        .get(id);
      return JSON.parse(row.public).preferences;
    },
    to: (deviceId) =>
      sent.filter((s) => s.endpoint.endsWith(`/${deviceId}`)).map((s) => s.payload.kind),
  };
}

const completed = (eventId) => ({ kind: "session-completed", eventId, sessionId: "s1" });
const question = (eventId) => ({
  kind: "question",
  eventId,
  sessionId: "s1",
  inbox: { type: "question", id: eventId },
});

test("devices on the old defaults stop getting informational pushes, once", async (t) => {
  const f = await fixture(t);
  const phone = await f.add("phone");
  const laptop = await f.add("laptop");
  f.asOlderRelease();
  await f.reopen();
  for (const device of [phone, laptop]) {
    const stored = f.stored(device.id);
    // Written as explicit booleans, which an older release reads unchanged.
    for (const kind of informationalKinds) assert.equal(stored.events[kind], false, kind);
    assert.equal(stored.events.question, true);
    assert.equal(stored.events["agent-hook-throttled"], true);
    assert.equal(stored.level, "label");
  }
  assert.equal(
    f.service.db.prepare("SELECT value FROM settings WHERE key=?").get(pushDefaultsKey)
      .value,
    "2",
  );
  // Blocking kinds still notify every device; "Response ready" no longer does.
  await f.service.notify(question("q1"));
  await f.service.notify(completed("c1"));
  assert.deepEqual(f.to("phone"), ["question"]);
  assert.deepEqual(f.to("laptop"), ["question"]);
  // A reminder someone asked an agent for still notifies; it used to be a routine result.
  await f.service.notify({ kind: "agent-reminder", eventId: "m1", assistantId: "a1" });
  await f.service.notify({ kind: "agent-routine", eventId: "r1", assistantId: "a1" });
  assert.deepEqual(f.to("phone"), ["question", "agent-reminder"]);
  assert.deepEqual(f.to("laptop"), ["question", "agent-reminder"]);
  // Switched on again, a kind stays on across restarts: it is never migrated again.
  await f.service.setPreferences(phone.id, { events: { "session-completed": true } });
  await f.reopen();
  await f.reopen();
  assert.equal(f.stored(phone.id).events["session-completed"], true);
  assert.equal(f.stored(laptop.id).events["session-completed"], false);
  await f.service.notify(completed("c2"));
  assert.deepEqual(f.to("phone"), ["question", "agent-reminder", "session-completed"]);
  assert.deepEqual(f.to("laptop"), ["question", "agent-reminder"]);
});

test("a new device starts on the new defaults and is never migrated", async (t) => {
  const f = await fixture(t);
  const tablet = await f.add("tablet");
  for (const kind of informationalKinds)
    assert.equal(tablet.preferences.events[kind], false, kind);
  await f.service.setPreferences(tablet.id, { events: { "agent-routine": true } });
  await f.reopen();
  assert.equal(f.stored(tablet.id).events["agent-routine"], true);
  await f.service.notify({ kind: "agent-routine", eventId: "r1", assistantId: "a1" });
  await f.service.notify({ kind: "update-available", eventId: "u1", label: "9.9.9" });
  await f.service.notify({ kind: "pipeline-gate", eventId: "g1", runId: "run-1" });
  assert.deepEqual(f.to("tablet"), ["agent-routine", "pipeline-gate"]);
});
