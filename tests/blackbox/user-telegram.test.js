import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, sharedAgentOfTwo, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";

const token = "123456:user-bot-secret-token";

// Telegram answers with the bot's identity; nothing leaves the host.
function fakeTelegram(f) {
  f.application.assistantChannels.clientFactory = () => ({
    identity: async () => ({ id: 777, username: "anna_helper_bot" }),
  });
}

async function extended(f, level = "extended") {
  const { user, cookie } = await signedInUser(f, "Anna");
  const agent = await userAgent(f, {
    mode: "own",
    members: [{ userId: user.id, level }],
  });
  return { user, cookie, agent, request: as(f, cookie) };
}

test("an Extended user pairs her own chat", async (t) => {
  const { f, gateway } = await chatFixture(t);
  fakeTelegram(f);
  const { user, agent, request } = await extended(f);
  const connected = await request(`/api/me/agents/${agent.id}/telegram`, {
    method: "PUT",
    body: { token, language: "en" },
  });
  assert.equal(connected.status, 200, await connected.clone().text());
  const { channel } = await connected.json();
  assert.equal(channel.username, "anna_helper_bot");
  assert.equal(channel.paired, false);
  const paired = await request(`/api/me/agents/${agent.id}/telegram/pair`, {
    method: "POST",
    body: {},
  });
  assert.equal(paired.status, 200, await paired.clone().text());
  const { code, url } = await paired.json();
  assert.match(url, /^https:\/\/t\.me\/anna_helper_bot\?start=/);
  const channels = f.application.assistantChannels;
  await channels.ingress.receive(channel.id, [telegramMessage(1, `/start ${code}`)]);
  await channels.ingress.receive(channel.id, [telegramMessage(2, "Hello from Telegram")]);
  await channels.ingress.dispatch(channel.id);
  const stored = channels.store.get(channel.id);
  const conversation = f.application.assistants.store.getConversation(
    stored.conversationId,
  );
  assert.equal(conversation.userId, user.id);
  assert.equal(conversation.assistantId, agent.id);
  assert.ok(gateway.sent.some((s) => s.key === conversation.runtimeSessionKey));
  const view = await (await request(`/api/me/agents/${agent.id}/telegram`)).json();
  assert.equal(view.channel.paired, true);
  // The token never appears in a response or the audit log.
  assert.doesNotMatch(JSON.stringify(view), /user-bot-secret/);
  assert.doesNotMatch(JSON.stringify(f.application.audit.list({})), /user-bot-secret/);
});

test("shared agents and lower levels are refused", async (t) => {
  const { f } = await chatFixture(t);
  fakeTelegram(f);
  const { request, agent } = await extended(f, "personalize");
  const lower = await request(`/api/me/agents/${agent.id}/telegram`, {
    method: "PUT",
    body: { token },
  });
  assert.equal(lower.status, 403);
  assert.equal((await lower.json()).code, "USER_LEVEL");
  const { anna, agent: family } = await sharedAgentOfTwo(f, "extended", [
    "Carla",
    "Dora",
  ]);
  const shared = await as(f, anna.cookie)(`/api/me/agents/${family.id}/telegram`);
  assert.equal(shared.status, 403);
  assert.equal((await shared.json()).code, "USER_LEVEL");
});

test("Telegram for other people stays unavailable", async (t) => {
  const { f } = await chatFixture(t);
  const { agent } = await extended(f);
  // The owner's own bot for other people is never offered on a user's agent.
  const response = await f.request(`/api/assistant-telegram-senders/${agent.id}`, {
    method: "PUT",
    body: { token, people: [], revision: null },
  });
  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).code, "USER_AGENT_LOCKED");
});
