import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

function device(deviceId) {
  const key = createECDH("prime256v1");
  key.generateKeys();
  return {
    deviceId,
    label: deviceId,
    subscription: {
      endpoint: `https://push.example.com/${deviceId}`,
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
  };
}

// The owner's phone and Anna's phone; every push is recorded by device.
async function phones(f, anna) {
  const sent = [];
  f.application.notifications.send = async (subscription, payload) => {
    sent.push({ device: subscription.endpoint.split("/").pop(), payload });
  };
  const owner = await f.request("/api/notifications/subscriptions", {
    method: "POST",
    body: device("owner-phone"),
  });
  assert.equal(owner.status, 201, await owner.clone().text());
  const hers = await as(f, anna.cookie)("/api/me/notifications/subscriptions", {
    method: "POST",
    body: device("anna-phone"),
  });
  assert.equal(hers.status, 201, await hers.clone().text());
  return sent;
}

// The notice goes out after the completion returns.
async function settled(sent) {
  for (let i = 0; i < 50 && !sent.length; i++)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return sent.map((entry) => entry.device).sort();
}

test("her reminder on a shared agent pushes only to her devices", async (t) => {
  const { f } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const ben = await signedInUser(f, "Ben");
  const agent = await userAgent(
    f,
    {
      mode: "shared",
      members: [
        { userId: anna.user.id, level: "personalize" },
        { userId: ben.user.id, level: "personalize" },
      ],
    },
    { capabilities: { memory: false, reminders: true } },
  );
  await as(f, anna.cookie)(`/api/me/agents/${agent.id}/conversation`, {
    method: "POST",
  });
  const created = await as(f, anna.cookie)(`/api/me/agents/${agent.id}/reminders`, {
    method: "POST",
    body: {
      clientRequestId: "dentist-request",
      name: "dentist",
      message: "Remember the dentist",
      schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  const sent = await phones(f, anna);
  const reminders = f.application.assistants.reminders;
  await reminders.complete(id, {
    jobId: reminders.bindings.get(id).nativeId,
    runAtMs: 1000,
    status: "ok",
    summary: "Dentist at three",
  });
  assert.deepEqual(await settled(sent), ["anna-phone"]);
});

test("her own agent's check-in pushes only to her devices", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: anna.user.id, level: "personalize" }] },
    { capabilities: { memory: true, reminders: false } },
  );
  const assistants = f.application.assistants;
  const heartbeat = { enabled: true, interval: "4h", start: 0, end: 24, timeZone: "UTC" };
  const record = assistants.store.getAssistant(agent.id);
  assistants.store.updateAssistant(agent.id, { heartbeat }, record.revision);
  await assistants.admit(() => assistants.reminders.heartbeats.sync(agent.id));
  const [job] = gateway.jobs.values();
  const binding = assistants.reminders.bindings
    .list(agent.id)
    .find((b) => b.kind === "heartbeat");
  assert.equal(binding.userId, anna.user.id);
  const sent = await phones(f, anna);
  await assistants.reminders.complete(binding.id, {
    jobId: job.id,
    runAtMs: 2000,
    status: "ok",
    summary: "Your parcel arrives today.",
    deliveryStatus: "delivered",
  });
  assert.deepEqual(await settled(sent), ["anna-phone"]);
});
