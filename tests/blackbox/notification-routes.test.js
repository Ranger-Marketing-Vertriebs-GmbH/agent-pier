import test from "node:test";
import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
test("notification HTTP registration survives restart, checks origins and audits without credentials", async (t) => {
  const f = await applicationFixture(t);
  const key = createECDH("prime256v1");
  key.generateKeys();
  const body = {
    deviceId: "device-one",
    label: "My phone",
    subscription: {
      endpoint: "https://push.example.com/private-capability",
      keys: {
        p256dh: key.getPublicKey().toString("base64url"),
        auth: randomBytes(16).toString("base64url"),
      },
    },
  };
  assert.equal(
    (
      await f.request("/api/notifications/subscriptions", {
        method: "POST",
        body,
        origin: "https://foreign.example",
      })
    ).status,
    403,
  );
  let response = await f.request("/api/notifications/subscriptions", {
    method: "POST",
    body,
  });
  assert.equal(response.status, 201);
  const { subscription } = await response.json();
  await f.restart();
  response = await f.request("/api/notifications");
  const status = await response.json();
  assert.equal(status.subscriptions[0].id, subscription.id);
  assert.equal(JSON.stringify(status).includes("private-capability"), false);
  f.application.notifications.send = async () => {
    throw Error("secret-provider-body");
  };
  response = await f.request("/api/notifications/test", {
    method: "POST",
    body: { subscriptionId: subscription.id },
  });
  const result = await response.json();
  assert.equal(result.sent, false);
  assert.equal(JSON.stringify(result).includes("secret-provider-body"), false);
  const audit = await (await f.request("/api/audit")).json();
  assert.equal(audit.events[0].action, "notification.tested");
  assert.equal(audit.events[0].outcome, "failure");
  assert.equal(JSON.stringify(audit).includes("My phone"), false);
  assert.equal(
    (
      await f.request(`/api/notifications/subscriptions/${subscription.id}`, {
        method: "DELETE",
      })
    ).status,
    200,
  );
  assert.equal(
    (await (await f.request("/api/notifications")).json()).subscriptions.length,
    0,
  );
  const health = await (await f.request("/api/health")).json();
  assert.equal(health.application, "agentpier");
  assert.ok(health.instanceId);
});
