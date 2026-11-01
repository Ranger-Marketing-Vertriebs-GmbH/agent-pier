import test from "node:test";
import assert from "node:assert/strict";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { fakeBotApi } from "../helpers/assistant-telegram-fakes.js";
import { eventually } from "../helpers/hermes-fake-runtime.js";
import { hermesSkip, strayAfterStop } from "../helpers/hermes-native.js";
import { deleteAgent, hermesApp, json } from "../helpers/hermes-app.js";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";

// The owner's Telegram chat with a Hermes agent, end to end on the pinned Hermes
// (AGENTPIER_HERMES_CONTRACT_RUNTIME): AgentPier's own channel layer pairs the bot
// through a loopback Telegram Bot API (assistant-telegram-fakes.js), polls the
// owner's message, hands it to the agent's Hermes session like a web turn and sends
// the reply from the history back to the paired chat. Hermes's own Telegram adapter
// stays off. Nothing leaves the host.
const options = { skip: hermesSkip, timeout: contractTimeout(900000) };
const token = "777:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const owner = { id: 4242, name: "Owner" };

test(
  "Hermes contract: a Telegram message reaches the Hermes session and its reply goes out",
  options,
  async (t) => {
    const app = await hermesApp(t);
    const { f, assistants, agent, runtime } = app;
    assert.equal(
      (await json(await f.request("/api/assistants"))).assistants.find(
        (a) => a.id === agent.id,
      ).runtimeInfo.capabilities.channels.available,
      true,
    );
    const api = await fakeBotApi({ [token]: { id: 777, username: "pier_hermes_bot" } });
    t.after(() => api.close());
    const channels = assistants.channels;
    channels.clientFactory = (secret) =>
      new TelegramClient({ token: secret, apiRoot: api.url });
    const created = await channels.create({
      assistantId: agent.id,
      token,
      language: "en",
    });
    const { code } = await channels.pair(created.id, created.revision);
    channels.start();
    api.text(token, owner, `/start ${code}`);
    await eventually(() => channels.store.get(created.id).enabled, 60000, "the pairing");
    // The paired chat writes to the agent; the reply comes back to the same chat.
    api.text(token, owner, "hello from telegram");
    await eventually(
      () =>
        api
          .sent(token, owner.id)
          .some((c) => String(c.params.text).includes("ECHO: hello from telegram")),
      120000,
      "the reply in Telegram",
    ).catch((error) => {
      // What AgentPier saw, so a failure names its step.
      error.message += ` (inputs ${JSON.stringify(
        channels.ledger.list(created.id).map((e) => [e.state, e.diagnostic]),
      )}; calls ${JSON.stringify(api.calls.map((c) => c.method))}; model ${
        app.model.requests.length
      })`;
      throw error;
    });
    const entry = channels.ledger
      .list(created.id)
      .find((e) => e.text === "hello from telegram");
    await eventually(
      () => channels.ledger.get(entry.id).state === "delivered",
      60000,
      "the input to be delivered",
    );
    // The turn ran in the agent's own Hermes session, as a web turn would.
    const chat = assistants.store.getConversation(created.conversationId);
    assert.match(
      chat.runtimeSessionKey,
      new RegExp(`^agent:${agent.runtimeAgentId}:hermes:`),
    );
    const history = await runtime.sessions.history({
      sessionKey: chat.runtimeSessionKey,
    });
    assert.ok(JSON.stringify(history).includes("hello from telegram"));
    // Hermes ran no bot of its own: no Telegram token in its home.
    assert.deepEqual(await runtime.channels.status({ probe: false }), {
      channelAccounts: { telegram: [] },
    });
    const home = app.fleet.sets.get(agent.runtimeAgentId).supervisor.agentPaths();
    await deleteAgent(app);
    await eventually(
      () => runtime.host.status().availability === "disabled",
      60000,
      "the agent's set to stop",
    );
    assert.deepEqual(await strayAfterStop({ root: home.hermesHome }), []);
    assert.deepEqual(await strayAfterStop({ root: f.dataDir }), []);
  },
);
