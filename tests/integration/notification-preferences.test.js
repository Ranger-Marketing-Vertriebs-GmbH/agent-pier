import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createECDH, randomBytes } from "node:crypto";
import { NotificationService } from "../../server/features/notifications/notification-service.js";

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

async function fixture(t, { now = () => Date.parse("2026-10-17T12:00:00Z") } = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-push-prefs-"));
  const sent = [];
  const send = async (secret, payload) => {
    sent.push({ endpoint: secret.endpoint, payload });
    return { statusCode: 201 };
  };
  const clock = { now };
  let service = new NotificationService({ dataDir, send, clock });
  t.after(async () => {
    await service.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const add = async (deviceId, extra = {}) =>
    (
      await service.subscribe({
        deviceId,
        label: deviceId,
        subscription: subscription(deviceId),
        ...extra,
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
      service = new NotificationService({ dataDir, send, clock });
    },
    to: (deviceId) => sent.filter((s) => s.endpoint.endsWith(`/${deviceId}`)),
  };
}

const question = (eventId, extra = {}) => ({
  kind: "question",
  eventId,
  sessionId: "session-one",
  inbox: { type: "question", id: eventId },
  label: "api-refactor",
  preview: "Which database should the tests use?",
  ...extra,
});

test("devices start at the event type only, keep their choices and store their time zone", async (t) => {
  const f = await fixture(t);
  const device = await f.add("phone", { timeZone: "Europe/Berlin" });
  assert.equal(device.preferences.level, "type");
  assert.equal(device.preferences.timeZone, "Europe/Berlin");
  await f.service.setPreferences(device.id, { level: "label" });
  // Renewing the push subscription (or renaming) keeps the preferences.
  await f.add("phone");
  const [stored] = f.service.status().subscriptions;
  assert.equal(stored.preferences.level, "label");
  assert.equal(stored.preferences.timeZone, "Europe/Berlin");
  await assert.rejects(f.service.setPreferences(device.id, { level: "everything" }));
  await assert.rejects(f.service.setPreferences("missing", { level: "type" }), {
    status: 404,
  });
});

test("subscriptions stored before preferences existed get the defaults", async (t) => {
  const f = await fixture(t);
  const device = await f.add("phone");
  const legacy = { id: device.id, deviceId: "phone", label: "Phone", createdAt: "x" };
  f.service.db
    .prepare("UPDATE subscriptions SET public=? WHERE id=?")
    .run(JSON.stringify(legacy), device.id);
  await f.reopen();
  const [stored] = f.service.status().subscriptions;
  assert.equal(stored.preferences.level, "type");
  assert.equal(stored.preferences.events["pipeline-failed"], true);
  await f.service.notify(question("request-legacy"));
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].payload.label, undefined);
});

test("each device gets its own level, events and badge count", async (t) => {
  const f = await fixture(t);
  const shared = await f.add("shared");
  const phone = await f.add("phone");
  const laptop = await f.add("laptop");
  await f.service.setPreferences(phone.id, { level: "label" });
  await f.service.setPreferences(laptop.id, {
    level: "preview",
    events: { question: true, "pipeline-completed": true },
  });
  await f.service.setPreferences(shared.id, { events: { question: false } });
  f.service.inboxCount = async () => 4;
  await f.service.notify(question("request-one"));
  assert.equal(f.to("shared").length, 0);
  assert.equal(f.to("phone")[0].payload.label, "api-refactor");
  assert.equal(f.to("phone")[0].payload.preview, undefined);
  assert.equal(f.to("laptop")[0].payload.preview, "Which database should the tests use?");
  assert.equal(f.to("laptop")[0].payload.count, 4);
  await f.service.notify({
    kind: "pipeline-completed",
    eventId: "run-done",
    runId: "r1",
  });
  assert.deepEqual(
    f.sent.filter((s) => s.payload.kind === "pipeline-completed").map((s) => s.endpoint),
    ["https://push.example.com/send/laptop"],
  );
});

test("a reply's preview is read only when a device shows previews", async (t) => {
  const f = await fixture(t);
  const device = await f.add("phone");
  let reads = 0;
  const completed = (eventId) => ({
    kind: "session-completed",
    eventId,
    sessionId: "s1",
    preview: async () => {
      reads++;
      return "Three tests still fail; shall I fix them?";
    },
  });
  await f.service.notify(completed("done-one"));
  assert.equal(reads, 0);
  await f.service.setPreferences(device.id, { level: "preview" });
  await f.service.notify(completed("done-two"));
  assert.equal(reads, 1);
  assert.equal(
    f.sent.at(-1).payload.preview,
    "Three tests still fail; shall I fix them?",
  );
});

test("quiet hours hold pushes per device, in its own time zone", async (t) => {
  // 21:30 UTC: 23:30 in Berlin, 17:30 in New York.
  const f = await fixture(t, { now: () => Date.parse("2026-10-17T21:30:00Z") });
  const berlin = await f.add("berlin", { timeZone: "Europe/Berlin" });
  const york = await f.add("york", { timeZone: "America/New_York" });
  for (const device of [berlin, york])
    await f.service.setPreferences(device.id, {
      quiet: { enabled: true, from: "22:00", to: "07:00" },
    });
  await f.service.notify(question("request-night"));
  assert.equal(f.to("berlin").length, 0);
  assert.equal(f.to("york").length, 1);
  await f.service.setPreferences(berlin.id, { quiet: { blockingThrough: true } });
  await f.service.notify(question("request-night-two"));
  await f.service.notify({ kind: "session-ended", eventId: "ended", sessionId: "s1" });
  assert.deepEqual(
    f.to("berlin").map((s) => s.payload.kind),
    ["question"],
  );
  // System warnings ignore quiet hours.
  await f.service.notify({ kind: "disk-space", eventId: "disk" });
  assert.equal(f.to("berlin").at(-1).payload.kind, "disk-space");
});

test("nothing is pushed about a view that was visible in the last 30 seconds", async (t) => {
  let now = Date.parse("2026-10-17T12:00:00Z");
  const f = await fixture(t, { now: () => now });
  await f.add("phone");
  assert.equal(f.service.reportPresence("/sessions/session-one/chat"), true);
  await f.service.notify(question("request-seen"));
  await f.service.notify({
    kind: "session-completed",
    eventId: "c1",
    sessionId: "session-one",
  });
  assert.equal(f.sent.length, 0);
  now += 31000;
  await f.service.notify(question("request-later"));
  assert.equal(f.sent.length, 1);
  f.service.reportPresence("/inbox");
  await f.service.notify(question("request-inbox", { sessionId: "session-two" }));
  await f.service.notify({
    kind: "session-completed",
    eventId: "c2",
    sessionId: "session-two",
  });
  assert.deepEqual(
    f.sent.map((s) => s.payload.eventId),
    ["request-later", "c2"],
  );
  // The test notification always goes out.
  const [device] = f.service.status().subscriptions;
  assert.equal((await f.service.test(device.id)).sent, true);
});
