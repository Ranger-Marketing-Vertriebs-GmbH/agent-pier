import fs from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

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
  gateway.history[key] = [
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

test("deleting without opt-in removes her chats", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, agent, id, file } = await annaWithChat(f, gateway);
  const copy = attachmentPath(f, agent, file);
  assert.ok(copy && fs.existsSync(copy));
  assert.equal((await remove(f, user.id, { agents: "archive" })).status, 204);
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
  assert.equal((await remove(f, user.id, { agents: "keep" })).status, 204);
  const response = await f.request(`/api/assistant-conversations/${id}/messages`);
  assert.equal(response.status, 200);
  const history = await response.json();
  assert.deepEqual(
    history.messages.map((m) => m.text),
    ["Private words"],
  );
  assert.equal(f.application.assistants.store.getConversation(id).deletedUser, true);
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
