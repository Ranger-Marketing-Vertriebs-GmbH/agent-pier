import fs from "node:fs";
import { createECDH, randomBytes } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { applicationFixture } from "../helpers/application.js";
import { deleteReleasedSessions } from "../../server/features/users/user-release.js";

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

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

// Anna with her own agent, an open chat holding a picture, and a message sent.
async function annaWithChat(f, gateway) {
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level: "personalize" }],
  });
  const request = as(f, cookie);
  const { id } = await (
    await request(`/api/me/agents/${agent.id}/conversation`, { method: "POST" })
  ).json();
  const uploaded = await fetch(
    `${f.url}/api/me/conversations/${id}/attachments?name=dot.png`,
    {
      method: "POST",
      headers: { cookie, origin: f.url, "content-type": "application/octet-stream" },
      body: png,
    },
  );
  const file = await uploaded.json();
  const store = f.application.assistants.store;
  const key = store.getConversation(id).runtimeSessionKey;
  // One message from before any opt-in, one after it.
  gateway.history[key] = [
    { role: "user", content: "Earlier words", timestamp: Date.now() - 60000 },
    { role: "user", content: "Private words", timestamp: Date.now() + 1000 },
  ];
  await request(`/api/me/conversations/${id}/messages`);
  return { user, cookie, agent, id, file };
}
const remove = (f, userId, body) =>
  f.request(`/api/users/${userId}`, { method: "DELETE", ...(body ? { body } : {}) });
const attachmentPath = (f, agent, file) => {
  const row = f.application.assistants.attachments.rows(
    "SELECT * FROM agent_attachments WHERE id=?",
    file.id,
  )[0];
  return (
    row &&
    `${f.application.assistants.config.workspaces}/${agent.id}/attachments/${row.file}`
  );
};

test("deleting without opt-in removes her chats and devices", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, cookie, agent, id, file } = await annaWithChat(f, gateway);
  const copy = attachmentPath(f, agent, file);
  assert.ok(copy && fs.existsSync(copy));
  const phone = await as(f, cookie)("/api/me/notifications/subscriptions", {
    method: "POST",
    body: device("anna-phone"),
  });
  assert.equal(phone.status, 201, await phone.clone().text());
  const devices = () =>
    f.application.notifications.db
      .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id=?")
      .get(user.id).n;
  assert.equal(devices(), 1);
  assert.equal((await remove(f, user.id, { agents: "archive" })).status, 204);
  assert.equal(devices(), 0);
  const messages = await f.request(`/api/assistant-conversations/${id}/messages`);
  assert.equal(messages.status, 404);
  assert.equal(fs.existsSync(copy), false);
  const store = f.application.assistants.store;
  assert.deepEqual(store.messages(id), []);
  assert.ok(store.getConversation(id).archivedAt);
  assert.ok(
    gateway.calls.some(
      (c) =>
        c.method === "sessions.delete" &&
        c.params.key === store.getConversation(id).runtimeSessionKey,
    ),
  );
});

test("deleting with opt-in keeps her chats readable from since", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, id } = await annaWithChat(f, gateway);
  await f.request(`/api/users/${user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  const { since } = f.application.users.get(user.id).ownerMayRead;
  assert.equal((await remove(f, user.id, { agents: "keep" })).status, 204);
  const response = await f.request(`/api/assistant-conversations/${id}/messages`);
  assert.equal(response.status, 200);
  const history = await response.json();
  // What she wrote before the opt-in stays hers after her deletion too.
  assert.deepEqual(
    history.messages.map((m) => m.text),
    ["Private words"],
  );
  const kept = f.application.assistants.store.getConversation(id);
  assert.equal(kept.deletedUser, true);
  assert.equal(kept.ownerMayReadSince, since);
});

test("keep moves own agents to the owner", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, cookie, agent } = await annaWithChat(f, gateway);
  assert.equal((await remove(f, user.id, { agents: "keep" })).status, 204);
  const kept = f.application.assistants.store.getAssistant(agent.id);
  assert.equal(kept.userAccess, null);
  assert.equal(kept.archivedAt, null);
  assert.equal(kept.shell, "off");
  // Her session is gone with her.
  assert.equal((await as(f, cookie)("/api/me")).status, 401);
});

test("archive archives them", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, agent } = await annaWithChat(f, gateway);
  const family = await sharedAgentOfTwo(f, "chat", ["Carla", "Dora"]);
  // Anna on the shared agent too: she leaves it, the others stay.
  const store = f.application.assistants.store;
  const shared = store.getAssistant(family.agent.id);
  store.setUserAccess(
    shared.id,
    {
      ...shared.userAccess,
      members: [...shared.userAccess.members, { userId: user.id, level: "chat" }],
    },
    shared.revision,
  );
  assert.equal((await remove(f, user.id, { agents: "archive" })).status, 204);
  assert.ok(store.getAssistant(agent.id).archivedAt);
  assert.deepEqual(
    store
      .getAssistant(family.agent.id)
      .userAccess.members.map((m) => m.userId)
      .sort(),
    [family.anna.user.id, family.ben.user.id].sort(),
  );
});

test("delete without a choice is refused while she owns agents", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user } = await annaWithChat(f, gateway);
  const refused = await remove(f, user.id);
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).code, "USER_AGENTS_CHOICE");
  const invalid = await remove(f, user.id, { agents: "later" });
  assert.equal(invalid.status, 400);
  // Without own agents no choice is needed.
  const other = await signedInUser(f, "Eve");
  assert.equal((await remove(f, other.user.id)).status, 204);
});

test("deleting a user with reminders ends them without blocking the agents", async (t) => {
  const { f } = await chatFixture(t);
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: user.id, level: "personalize" }] },
    { capabilities: { memory: false, reminders: true } },
  );
  const created = await as(f, cookie)(`/api/me/agents/${agent.id}/reminders`, {
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
  const timeout = new Promise((resolve) => setTimeout(() => resolve("stuck"), 5000));
  const removed = await Promise.race([remove(f, user.id, { agents: "keep" }), timeout]);
  assert.notEqual(removed, "stuck");
  assert.equal(removed.status, 204);
  const reminders = f.application.assistants.reminders;
  assert.equal(reminders.bindings.get(id).state, "removed");
  // The admission lock is free again for every other agent operation.
  const admitted = await Promise.race([
    f.application.assistants.admit(() => "admitted"),
    new Promise((resolve) => setTimeout(() => resolve("stuck"), 2000)),
  ]);
  assert.equal(admitted, "admitted");
});

test("deleting a user while agents are off is refused and keeps her data", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, id } = await annaWithChat(f, gateway);
  const off = await f.request("/api/assistant-feature", {
    method: "PUT",
    body: { enabled: false },
  });
  assert.equal(off.status, 200, await off.clone().text());
  assert.equal(f.application.assistants, null);
  for (const body of [undefined, { agents: "archive" }]) {
    const refused = await remove(f, user.id, body);
    assert.equal(refused.status, 503);
    assert.equal((await refused.json()).code, "USER_AGENTS_OFF");
  }
  assert.equal(f.application.users.get(user.id).id, user.id);
  const on = await f.request("/api/assistant-feature", {
    method: "PUT",
    body: { enabled: true },
  });
  assert.equal(on.status, 200, await on.clone().text());
  assert.equal(f.application.assistants.store.getConversation(id).userId, user.id);
});

test("a Gateway away at her deletion never brings her transcript back", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, id } = await annaWithChat(f, gateway);
  const assistants = f.application.assistants;
  const key = assistants.store.getConversation(id).runtimeSessionKey;
  gateway.client.ready = false;
  assert.equal((await remove(f, user.id, { agents: "archive" })).status, 204);
  assert.deepEqual(assistants.store.messages(id), []);
  // The next start reconciles every chat before her native session is deleted.
  gateway.client.ready = true;
  gateway.calls.length = 0;
  await assistants.reconcile();
  assert.deepEqual(assistants.store.messages(id), []);
  assert.equal(
    gateway.calls.some((c) => [c.params?.key, c.params?.sessionKey].includes(key)),
    false,
  );
  await deleteReleasedSessions({ assistants });
  assert.equal(assistants.store.getConversation(id).nativeDeletePending, false);
  await assistants.reconcile();
  assert.deepEqual(assistants.store.messages(id), []);
});

test("a history read across her deletion caches nothing of hers", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, id } = await annaWithChat(f, gateway);
  const assistants = f.application.assistants;
  const call = gateway.client.call;
  let release;
  const held = new Promise((resolve) => (release = resolve));
  gateway.client.call = async (method, params) => {
    const result = await call(method, params);
    if (method === "chat.history") await held;
    return result;
  };
  // Her agent answered since the last read: the page differs from the cache.
  const key = assistants.store.getConversation(id).runtimeSessionKey;
  gateway.history[key].push({
    role: "assistant",
    content: "Reply",
    timestamp: Date.now(),
  });
  const reading = assistants.history(id);
  assert.equal((await remove(f, user.id, { agents: "archive" })).status, 204);
  release();
  await reading;
  assert.deepEqual(assistants.store.messages(id), []);
});

test("deleting a user where agents never ran removes her devices", async (t) => {
  const f = await applicationFixture(t);
  assert.equal(f.application.assistants, null);
  const { user, cookie } = await signedInUser(f, "Anna");
  const phone = await as(f, cookie)("/api/me/notifications/subscriptions", {
    method: "POST",
    body: device("anna-phone"),
  });
  assert.equal(phone.status, 201, await phone.clone().text());
  assert.equal((await remove(f, user.id)).status, 204);
  const left = f.application.notifications.db
    .prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id=?")
    .get(user.id).n;
  assert.equal(left, 0);
});
