import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, pairedTelegram, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";

const reminderBody = (name) => ({
  clientRequestId: `${name}-request`,
  name,
  message: `Remember ${name}`,
  schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
});

// Anna (Extended) with her own agent, her paired bot and one Telegram message sent.
async function annaOnTelegram(f) {
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: user.id, level: "extended" }] },
    { capabilities: { memory: false, reminders: true } },
  );
  const request = as(f, cookie);
  const channel = await pairedTelegram(f, request, agent.id);
  const channels = f.application.assistantChannels;
  await channels.ingress.receive(channel.id, [telegramMessage(2, "Private-telegram")]);
  await channels.ingress.dispatch(channel.id);
  return { user, cookie, request, agent, channel };
}

const remove = (f, userId, body) =>
  f.request(`/api/users/${userId}`, { method: "DELETE", body });

test("deleting a user removes her bot and her message texts", async (t) => {
  const { f } = await chatFixture(t);
  const { user, channel } = await annaOnTelegram(f);
  const conversationId = channel.conversationId;
  const assistants = f.application.assistants;
  assert.ok(assistants.ledger.requests(conversationId).length);
  assert.equal((await remove(f, user.id, { agents: "keep" })).status, 204);
  const channels = f.application.assistantChannels;
  assert.deepEqual(channels.store.list(), []);
  assert.equal(channels.store.secret(channel.id), null);
  assert.deepEqual(channels.ledger.public(channel.id), []);
  for (const request of assistants.ledger.requests(conversationId))
    assert.equal(request.text, "");
  const listed = await (await f.request("/api/assistant-channels")).json();
  assert.doesNotMatch(JSON.stringify(listed), /Private-telegram/);
});

test("a kept chat of a deleted user takes no new turns", async (t) => {
  const { f } = await chatFixture(t);
  const { user, channel } = await annaOnTelegram(f);
  await f.request(`/api/users/${user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  assert.equal((await remove(f, user.id, { agents: "keep" })).status, 204);
  const assistants = f.application.assistants;
  assert.equal(
    assistants.store.getConversation(channel.conversationId).deletedUser,
    true,
  );
  assert.deepEqual(f.application.assistantChannels.store.list(), []);
  await assert.rejects(
    assistants.send(
      channel.conversationId,
      { clientRequestId: "late", text: "Still here" },
      { kind: "telegram" },
    ),
    { status: 404 },
  );
});

test("an own agent stays with its user: no other user, no sharing", async (t) => {
  const { f } = await chatFixture(t);
  const { user, request, agent, channel } = await annaOnTelegram(f);
  const created = await request(`/api/me/agents/${agent.id}/reminders`, {
    method: "POST",
    body: reminderBody("dentist"),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  const ben = await signedInUser(f, "Ben");
  const anna = { userId: user.id, level: "extended" };
  const bens = { userId: ben.user.id, level: "extended" };
  const store = f.application.assistants.store;
  // Her memory, files and browser would go to Ben, or to the owner once shared.
  for (const userAccess of [
    { mode: "own", members: [bens] },
    { mode: "shared", members: [anna] },
    { mode: "shared", members: [anna, bens] },
  ]) {
    const moved = await f.request(`/api/user-agents/${agent.id}/access`, {
      method: "PUT",
      body: { userAccess, revision: store.getAssistant(agent.id).revision },
    });
    assert.equal(moved.status, 409, JSON.stringify(userAccess));
    assert.equal((await moved.json()).code, "USER_AGENT_OWN_FIXED");
  }
  assert.equal(store.getAssistant(agent.id).userAccess.mode, "own");
  assert.equal((await f.request(`/api/assistants/${agent.id}/memory`)).status, 404);
  assert.deepEqual(
    (await as(f, ben.cookie)(`/api/me/agents/${agent.id}/memory`)).status,
    404,
  );
  assert.equal(f.application.assistantChannels.store.list()[0].id, channel.id);
  assert.notEqual(f.application.assistants.reminders.bindings.get(id).state, "removed");
  // Her level may still change.
  const level = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "own", members: [{ ...anna, level: "chat" }] },
      revision: store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(level.status, 200, await level.clone().text());
});

test("a member removed from a shared agent loses her reminders on it", async (t) => {
  const { f } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const ben = await signedInUser(f, "Ben");
  const members = [
    { userId: anna.user.id, level: "personalize" },
    { userId: ben.user.id, level: "personalize" },
  ];
  const agent = await userAgent(
    f,
    { mode: "shared", members },
    { capabilities: { memory: false, reminders: true } },
  );
  const created = await as(f, ben.cookie)(`/api/me/agents/${agent.id}/reminders`, {
    method: "POST",
    body: reminderBody("bens"),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  const current = f.application.assistants.store.getAssistant(agent.id);
  const changed = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "shared", members: [members[0]] },
      revision: current.revision,
    },
  });
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal(f.application.assistants.reminders.bindings.get(id).state, "removed");
});

test("a user lowered below Extended loses her bot on her agent", async (t) => {
  const { f } = await chatFixture(t);
  const { user, agent, channel } = await annaOnTelegram(f);
  const store = f.application.assistants.store;
  const lowered = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "own", members: [{ userId: user.id, level: "personalize" }] },
      revision: store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(lowered.status, 200, await lowered.clone().text());
  const channels = f.application.assistantChannels;
  assert.deepEqual(channels.store.list(), []);
  assert.equal(channels.store.secret(channel.id), null);
});

test("a disabled user's bot, reminders and turns end", async (t) => {
  const { f } = await chatFixture(t);
  const { user, request, agent, channel } = await annaOnTelegram(f);
  const created = await request(`/api/me/agents/${agent.id}/reminders`, {
    method: "POST",
    body: reminderBody("dentist"),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { id } = await created.json();
  const disabled = await f.request(`/api/users/${user.id}`, {
    method: "PATCH",
    body: { disabled: true },
  });
  assert.equal(disabled.status, 200, await disabled.clone().text());
  assert.deepEqual(f.application.assistantChannels.store.list(), []);
  assert.equal(f.application.assistants.reminders.bindings.get(id).state, "removed");
  // Nothing else starts a turn in her chat while she is disabled.
  await assert.rejects(
    f.application.assistants.send(
      channel.conversationId,
      { clientRequestId: "late", text: "Still here" },
      { kind: "telegram" },
    ),
    { status: 404 },
  );
});
