import test from "node:test";
import assert from "node:assert/strict";
import { chatFixture } from "../helpers/user-chats.js";
import { fixtureModel } from "../helpers/user-agents.js";
import { telegramMessage } from "../helpers/assistant-channel-fixture.js";

// The new agent wizard (handoff 5.3) creates the agent, connects its Telegram bot and
// then its first routine, in that order, through the real owner endpoints. The bot is
// paired only after creating, so the routine is created without Telegram; it can be
// switched on once the chat is paired.
async function json(response, status) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test("the wizard's routine is refused with Telegram before pairing and created without it", async (t) => {
  const { f } = await chatFixture(t);
  const channels = f.application.assistantChannels;
  channels.clientFactory = () => ({
    identity: async () => ({ id: 777, username: "scout_bot" }),
  });
  const agent = await json(
    await f.request("/api/assistants", {
      method: "POST",
      body: {
        name: "Scout",
        instructions: "",
        model: fixtureModel(f),
        capabilities: { memory: true, reminders: true },
      },
    }),
    201,
  );
  const channel = await json(
    await f.request("/api/assistant-channels", {
      method: "POST",
      body: { assistantId: agent.id, token: "123456:wizard-bot-token", language: "en" },
    }),
    201,
  );
  const routine = {
    clientRequestId: "wizard-routine-1",
    name: "Daily overview",
    prompt: "Sum up the news",
    trigger: { kind: "cron", expr: "30 8 * * *", tz: "Europe/Berlin" },
  };
  const base = `/api/assistants/${agent.id}/routines`;
  // What the wizard sent before: Telegram for a bot that is connected, not paired.
  const refused = await f.request(base, {
    method: "POST",
    body: { ...routine, telegram: true },
  });
  assert.equal(refused.status, 409, await refused.clone().text());
  assert.equal((await refused.json()).messageKey, "assistants.reminderChannelRequired");
  // What it sends now (wizard-creation.js): the routine alone.
  const created = await json(
    await f.request(base, { method: "POST", body: routine }),
    201,
  );
  assert.equal(created.telegram, false);
  // Once paired, Telegram is switched on for the routine (Automatisierung).
  const pairing = await json(
    await f.request(`/api/assistant-channels/${channel.id}/pair`, {
      method: "POST",
      body: { revision: channel.revision },
    }),
    200,
  );
  await channels.ingress.receive(channel.id, [
    telegramMessage(1, `/start ${pairing.code}`),
  ]);
  const on = await json(
    await f.request(`${base}/${created.id}`, {
      method: "PATCH",
      body: { telegram: true, revision: created.revision },
    }),
    200,
  );
  assert.equal(on.telegram, true);
});
