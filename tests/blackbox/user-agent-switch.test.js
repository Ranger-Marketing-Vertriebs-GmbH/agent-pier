import test from "node:test";
import assert from "node:assert/strict";
import { as, chatFixture, userAgent } from "../helpers/user-chats.js";
import { signedInUser } from "../helpers/users.js";

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

test("a shared agent that becomes a user's own ends the owner's jobs and bot", async (t) => {
  const { f, gateway } = await chatFixture(t);
  const anna = await signedInUser(f, "Anna");
  const members = [{ userId: anna.user.id, level: "personalize" }];
  const agent = await userAgent(
    f,
    { mode: "shared", members },
    { capabilities: { memory: true, reminders: true } },
  );
  const assistants = f.application.assistants;
  const ownerChat = await assistants.admit(() =>
    assistants.reminders.openMain(agent.id, null),
  );
  const channel = pairedChannel(f, agent.id, ownerChat, 9001);
  const routine = await f.request(`/api/assistants/${agent.id}/routines`, {
    method: "POST",
    body: {
      clientRequestId: "owner-morning",
      name: "morning",
      prompt: "Summarise what you remember",
      trigger: { kind: "cron", expr: "0 9 * * *", tz: "UTC" },
      telegram: true,
    },
  });
  assert.equal(routine.status, 201, await routine.clone().text());
  const reminder = await f.request(`/api/assistants/${agent.id}/reminders`, {
    method: "POST",
    body: {
      clientRequestId: "owner-reminder",
      name: "owner",
      message: "Owner's note",
      schedule: { kind: "at", at: new Date(Date.now() + 3600000).toISOString() },
    },
  });
  assert.equal(reminder.status, 201, await reminder.clone().text());
  // Anna's own routine on the shared agent stays hers.
  const hers = await as(f, anna.cookie)(`/api/me/agents/${agent.id}/routines`, {
    method: "POST",
    body: {
      clientRequestId: "anna-bank",
      name: "bank",
      prompt: "Check the bank",
      trigger: { kind: "cron", expr: "0 8 * * *", tz: "UTC" },
    },
  });
  assert.equal(hers.status, 201, await hers.clone().text());
  const annas = (await hers.json()).id;
  assert.equal(gateway.jobs.size, 3);
  const switched = await f.request(`/api/user-agents/${agent.id}/access`, {
    method: "PUT",
    body: {
      userAccess: { mode: "own", members },
      revision: assistants.store.getAssistant(agent.id).revision,
    },
  });
  assert.equal(switched.status, 200, await switched.clone().text());
  const bindings = assistants.reminders.bindings.list(agent.id);
  for (const binding of bindings.filter((b) => b.userId !== anna.user.id))
    assert.equal(binding.state, "removed", binding.name);
  assert.equal(assistants.reminders.bindings.get(annas).state, "bound");
  assert.deepEqual(
    [...gateway.jobs.values()].map((j) => j.name),
    ["bank"],
  );
  assert.ok(
    !f.application.assistantChannels.store.list().some((c) => c.id === channel.id),
    "the owner's bot no longer delivers from her agent",
  );
  // Once his chat is gone, her routines still sync.
  assistants.store.updateConversation(ownerChat.id, {
    archivedAt: new Date().toISOString(),
  });
  await assistants.admit(() => assistants.reminders.routines.sync(agent.id));
});
