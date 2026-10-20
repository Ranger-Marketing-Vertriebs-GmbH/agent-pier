import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

const heartbeat = { enabled: true, interval: "4h", start: 0, end: 24, timeZone: "UTC" };

// A paired, enabled Telegram channel of the agent that delivers into `conversation`.
function pairedChannel(f, agentId, conversation, botId) {
  const store = f.application.assistantChannels.store;
  const created = store.create({
    assistantId: agentId,
    conversationId: conversation.id,
    botId,
    username: `bot_${botId}`,
    token: `${botId}:owner-bot-secret-token`,
  });
  return store.write(
    { ...created, chatId: 4242, userId: 4242, enabled: true },
    created.revision,
  );
}

test("her check-ins and reminders never go to another person's bot", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const agent = await userAgent(
    f,
    { mode: "own", members: [{ userId: anna.user.id, level: "extended" }] },
    { capabilities: { memory: true, reminders: true } },
  );
  const assistants = f.application.assistants;
  // A bot left over that delivers into the owner's old chat on the agent.
  const ownerChat = assistants.store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: `agent:${agent.id}:owner`,
    channel: "agentpier",
  });
  pairedChannel(f, agent.id, ownerChat, 9002);
  const record = assistants.store.getAssistant(agent.id);
  assistants.store.updateAssistant(agent.id, { heartbeat }, record.revision);
  await assistants.admit(() => assistants.reminders.heartbeats.sync(agent.id));
  const checkIn = assistants.reminders.bindings
    .list(agent.id)
    .find((b) => b.kind === "heartbeat");
  assert.equal(checkIn.userId, anna.user.id);
  assert.equal(checkIn.telegram ?? null, null);
  assert.equal(gateway.jobs.size, 1);
  const reminder = await as(f, anna.cookie)(`/api/me/agents/${agent.id}/reminders`, {
    method: "POST",
    body: {
      clientRequestId: "anna-telegram",
      name: "dentist",
      message: "Dentist",
      schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
    },
  });
  assert.equal(reminder.status, 201, await reminder.clone().text());
  // Its Telegram extra finds no bot of hers.
  const binding = assistants.reminders.bindings.get((await reminder.json()).id);
  assert.throws(() => assistants.reminders.setTelegram(binding, true), { status: 409 });
  assert.equal(assistants.reminders.bindings.get(binding.id).telegram ?? null, null);
});
