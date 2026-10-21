import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { as } from "../helpers/user-chats.js";
import { signedInUser, signIn, userPassword } from "../helpers/users.js";

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

// The owner's phone and Anna's phone, with every push recorded by endpoint.
async function devices(t) {
  const f = await applicationFixture(t);
  const sent = [];
  f.application.notifications.send = async (subscription, payload) => {
    sent.push({ endpoint: subscription.endpoint, payload });
  };
  const anna = await signedInUser(f, "Anna");
  const owner = await (
    await f.request("/api/notifications/subscriptions", {
      method: "POST",
      body: device("owner-phone"),
    })
  ).json();
  const response = await as(f, anna.cookie)("/api/me/notifications/subscriptions", {
    method: "POST",
    body: device("anna-phone"),
  });
  assert.equal(response.status, 201, await response.clone().text());
  const mine = await response.json();
  const notifications = f.application.notifications;
  const deliveries = async (notice) => {
    sent.length = 0;
    await notifications.notify(notice);
    return sent.map((entry) => entry.endpoint.split("/").pop()).sort();
  };
  return { f, anna, owner: owner.subscription, mine: mine.subscription, deliveries };
}

const routine = (eventId, extra = {}) => ({
  kind: "agent-routine",
  eventId,
  assistantId: "agent",
  ...extra,
});

test("a user's reminder notifies only her devices", async (t) => {
  const { anna, deliveries } = await devices(t);
  assert.deepEqual(
    await deliveries(routine("r1", { audience: { kind: "user", userId: anna.user.id } })),
    ["anna-phone"],
  );
});

test("owner events and system notices never reach user devices", async (t) => {
  const { anna, deliveries } = await devices(t);
  assert.deepEqual(await deliveries(routine("r2")), ["owner-phone"]);
  // A system notice stays the owner's, whatever audience it names.
  assert.deepEqual(
    await deliveries({
      kind: "disk-space",
      eventId: "d1",
      audience: { kind: "user", userId: anna.user.id },
    }),
    ["owner-phone"],
  );
});

test("the owner's device list excludes user devices", async (t) => {
  const { f, anna, owner, mine } = await devices(t);
  const listed = await (await f.request("/api/notifications")).json();
  assert.deepEqual(
    listed.subscriptions.map((d) => d.id),
    [owner.id],
  );
  const hers = await (await as(f, anna.cookie)("/api/me/notifications")).json();
  assert.deepEqual(
    hers.subscriptions.map((d) => d.id),
    [mine.id],
  );
  // The owner reaches none of her devices.
  const changed = await f.request(
    `/api/notifications/subscriptions/${mine.id}/preferences`,
    { method: "PUT", body: { level: "silent" } },
  );
  assert.equal(changed.status, 404);
});

test("a user cannot change the owner's device", async (t) => {
  const { f, anna, owner } = await devices(t);
  const request = as(f, anna.cookie);
  const changed = await request(
    `/api/me/notifications/subscriptions/${owner.id}/preferences`,
    { method: "PUT", body: { level: "silent" } },
  );
  assert.equal(changed.status, 404);
  const tested = await request("/api/me/notifications/test", {
    method: "POST",
    body: { subscriptionId: owner.id },
  });
  assert.equal(tested.status, 404);
  await request(`/api/me/notifications/subscriptions/${owner.id}`, { method: "DELETE" });
  const listed = await (await f.request("/api/notifications")).json();
  assert.equal(listed.subscriptions.length, 1);
});

test("quiet hours apply per user device", async (t) => {
  const { f, anna, mine, deliveries } = await devices(t);
  const now = new Date();
  const start = `${String(now.getUTCHours()).padStart(2, "0")}:00`;
  const end = `${String((now.getUTCHours() + 2) % 24).padStart(2, "0")}:00`;
  const response = await as(f, anna.cookie)(
    `/api/me/notifications/subscriptions/${mine.id}/preferences`,
    {
      method: "PUT",
      body: { quiet: { enabled: true, from: start, to: end }, timeZone: "UTC" },
    },
  );
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(
    await deliveries(routine("r3", { audience: { kind: "user", userId: anna.user.id } })),
    [],
  );
  // The owner's device keeps its own settings.
  assert.deepEqual(await deliveries(routine("r4")), ["owner-phone"]);
});

test("signing out forgets her browser's device, never the owner's", async (t) => {
  const { f, anna, owner, deliveries } = await devices(t);
  const out = (deviceId) =>
    f.request("/auth/logout", {
      method: "POST",
      headers: { cookie: anna.cookie },
      body: { deviceId },
    });
  // A device id she does not hold stays: her sign-out names only her own.
  assert.equal((await out("owner-phone")).status, 204);
  const listed = await (await f.request("/api/notifications")).json();
  assert.deepEqual(
    listed.subscriptions.map((d) => d.id),
    [owner.id],
  );
  anna.cookie = await signIn(f, "Anna");
  assert.equal((await out("anna-phone")).status, 204);
  assert.deepEqual(
    await deliveries(routine("r9", { audience: { kind: "user", userId: anna.user.id } })),
    [],
  );
  assert.deepEqual(await deliveries(routine("r10")), ["owner-phone"]);
});

test("signing in on a browser another person registered stops their notices", async (t) => {
  const { f, anna, deliveries } = await devices(t);
  const response = await f.request("/auth/login", {
    method: "POST",
    headers: { cookie: "" },
    body: { username: "Anna", password: userPassword, deviceId: "owner-phone" },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await deliveries(routine("r11")), []);
  // Her own device stays when she signs in again on it.
  await f.request("/auth/login", {
    method: "POST",
    headers: { cookie: "" },
    body: { username: "Anna", password: userPassword, deviceId: "anna-phone" },
  });
  assert.deepEqual(
    await deliveries(
      routine("r12", { audience: { kind: "user", userId: anna.user.id } }),
    ),
    ["anna-phone"],
  );
});

test("signing her out remotely forgets her other devices, never the owner's", async (t) => {
  const { f, anna, deliveries } = await devices(t);
  const hers = routine("r20", { audience: { kind: "user", userId: anna.user.id } });
  const register = async (deviceId) => {
    const response = await as(f, anna.cookie)("/api/me/notifications/subscriptions", {
      method: "POST",
      body: device(deviceId),
    });
    assert.equal(response.status, 201, await response.clone().text());
  };
  await register("family-ipad");
  assert.deepEqual(await deliveries({ ...hers, eventId: "r21" }), [
    "anna-phone",
    "family-ipad",
  ]);
  // Her own password change keeps only the browser she changed it on.
  let response = await f.request("/api/me/password", {
    method: "PUT",
    headers: { cookie: anna.cookie },
    body: { current: userPassword, next: "a-new-user-password", deviceId: "anna-phone" },
  });
  assert.equal(response.status, 204);
  assert.deepEqual(await deliveries({ ...hers, eventId: "r22" }), ["anna-phone"]);
  // The owner's reset signs out every device of hers.
  await register("family-ipad");
  response = await f.request(`/api/users/${anna.user.id}/password`, {
    method: "POST",
    body: { password: "reset-by-the-owner" },
  });
  assert.equal(response.status, 204);
  assert.deepEqual(await deliveries({ ...hers, eventId: "r23" }), []);
  assert.deepEqual(await deliveries(routine("r24")), ["owner-phone"]);
  // So does turning off "Sign-in allowed".
  anna.cookie = await signIn(f, "Anna", "reset-by-the-owner");
  await register("family-ipad");
  response = await f.request(`/api/users/${anna.user.id}`, {
    method: "PATCH",
    body: { disabled: true },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await deliveries({ ...hers, eventId: "r25" }), []);
  assert.deepEqual(await deliveries(routine("r26")), ["owner-phone"]);
});
