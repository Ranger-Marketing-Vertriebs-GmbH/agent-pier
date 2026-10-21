import test from "node:test";
import assert from "node:assert/strict";
import {
  as,
  chatFixture,
  pairedTelegram,
  sharedAgentOfTwo,
  userAgent,
} from "../helpers/user-chats.js";
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

test("the owner's channel list shows a user's Telegram texts only under her opt-in", async (t) => {
  const { f } = await chatFixture(t);
  const { user, agent, request } = await extended(f);
  const channel = await pairedTelegram(f, request, agent.id);
  const channels = f.application.assistantChannels;
  await channels.ingress.receive(channel.id, [telegramMessage(2, "Before-opt-in")]);
  const ownerList = async () =>
    (await (await f.request("/api/assistant-channels")).json()).channels.find(
      (c) => c.id === channel.id,
    );
  const hidden = await ownerList();
  assert.doesNotMatch(JSON.stringify(hidden), /Before-opt-in/);
  assert.equal(hidden.chatId, null);
  assert.deepEqual(hidden.inputs, []);
  await f.request(`/api/users/${user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await channels.ingress.receive(channel.id, [telegramMessage(3, "After-opt-in")]);
  const readable = JSON.stringify(await ownerList());
  assert.doesNotMatch(readable, /Before-opt-in/);
  assert.match(readable, /After-opt-in/);
});

test("the owner pairs and removes his own bot on a shared agent", async (t) => {
  const { f } = await chatFixture(t);
  fakeTelegram(f);
  const { agent } = await sharedAgentOfTwo(f, "extended", ["Carla", "Dora"]);
  const created = await f.request("/api/assistant-channels", {
    method: "POST",
    body: { assistantId: agent.id, token, language: "en" },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const channel = await created.json();
  const paired = await f.request(`/api/assistant-channels/${channel.id}/pair`, {
    method: "POST",
    body: { revision: channel.revision },
  });
  assert.equal(paired.status, 200, await paired.clone().text());
  const current = f.application.assistantChannels.store.get(channel.id);
  const removed = await f.request(`/api/assistant-channels/${channel.id}`, {
    method: "DELETE",
    body: { revision: current.revision },
  });
  assert.equal(removed.status, 200, await removed.clone().text());
});

test("her Telegram message held back before the opt-in stays hers once it goes out", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { user, agent, request } = await extended(f);
  const channel = await pairedTelegram(f, request, agent.id);
  const channels = f.application.assistantChannels;
  // The Gateway is away: her message waits in her bot's inbox.
  gateway.client.ready = false;
  await channels.ingress.receive(channel.id, [telegramMessage(2, "Held-back")]);
  await channels.ingress.dispatch(channel.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.request(`/api/users/${user.id}/owner-may-read`, {
    method: "PUT",
    body: { enabled: true },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  gateway.client.ready = true;
  await channels.ingress.dispatch(channel.id);
  const sent = gateway.sent.at(-1);
  assert.match(sent.message, /Held-back/);
  const conversationId = channels.store.get(channel.id).conversationId;
  const key =
    f.application.assistants.store.getConversation(conversationId).runtimeSessionKey;
  gateway.history[key] = [
    {
      role: "user",
      content: sent.message,
      timestamp: Date.now(),
      idempotencyKey: `${sent.idempotencyKey}:user`,
      __openclaw: { id: "m1" },
    },
  ];
  const history = await (
    await f.request(`/api/assistant-conversations/${conversationId}/messages`)
  ).json();
  assert.doesNotMatch(JSON.stringify(history), /Held-back/);
  assert.deepEqual(history.requests, []);
});

test("her Telegram turns name her chat and are never chat commands", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const { agent, request } = await extended(f);
  const channel = await pairedTelegram(f, request, agent.id);
  const assistants = f.application.assistants;
  // As telegram-ingress.js hands her bot messages to the agent.
  const turn = async (id, text) => {
    const result = await assistants.send(
      channel.conversationId,
      { clientRequestId: `telegram:${id}`, text },
      {
        kind: "telegram",
        channelId: channel.id,
        chatId: channel.chatId,
        userId: channel.userId,
        inputId: id,
      },
    );
    assert.ok(!result?.created && !result?.chat, text);
    const sent = gateway.sent.at(-1);
    // A user's chat never sends OpenClaw commands: a word joiner leads them.
    assert.equal(sent.message.replace(/^\u2060/, ""), text);
    gateway.runs[sent.idempotencyKey] = { status: "ok" };
    await assistants.reconcile();
  };
  const titles = async () =>
    (await (await request(`/api/me/agents/${agent.id}/chats`)).json()).map(
      (c) => c.title,
    );
  // Her first turn from the bot names the main chat.
  await turn("tg-1", "Plan the trip to Lisbon");
  assert.deepEqual(await titles(), ["Plan the trip to Lisbon"]);
  // `/new` and `/name` from Telegram go to the agent: no new chat, no rename.
  await turn("tg-2", "/new");
  await turn("tg-3", "/name Groceries");
  assert.deepEqual(await titles(), ["Plan the trip to Lisbon"]);
});
