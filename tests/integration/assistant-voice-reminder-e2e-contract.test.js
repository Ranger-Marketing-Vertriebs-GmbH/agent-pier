import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import { e2eGraph, turnOf } from "../helpers/assistant-e2e-graph.js";
import { fakeBotApi, fakeDeepgram } from "../helpers/assistant-telegram-fakes.js";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";
import { SpeechService } from "../../server/features/speech/speech-service.js";
import { DeepgramTranscriber } from "../../server/features/speech/deepgram-transcriber.js";

// Recorded end-to-end run (AGENTPIER-173): a voice note to the owner's AgentPier
// Telegram bot is transcribed, reaches the agent, the agent creates a native
// reminder, and the reminder fires and comes back through Telegram and the chat.
// The production assistant graph runs on the pinned runtime; Telegram, Deepgram and
// the model are loopback doubles, so no request leaves the machine.
const installed = process.env.AGENTPIER_E2E_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_E2E_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const token = "7101:fixture-owner-bot-abcdefghijklmnopqrstuvwxyz";
const owner = { id: "4242", name: "Owner" };
const transcript = "E2E_VOICE remind me in a few seconds to water the plants";
const reminderText = "E2E_REMINDER water the plants";

test(
  "voice note to reminder delivered through Telegram and the chat",
  options,
  async (t) => {
    const h = await e2eGraph(t, installed, { prefix: "agentpier-e2e-voice-" });
    const bots = await fakeBotApi({
      [token]: { id: 7101, username: "owner_fixture_bot" },
    });
    const deepgram = await fakeDeepgram(transcript);
    t.after(() => Promise.all([bots.close(), deepgram.close()]));
    const channels = h.graph.assistantChannels;
    // Test seams only: the owner's bot client and Deepgram reach the loopback fakes.
    channels.clientFactory = (secret) =>
      new TelegramClient({ token: secret, apiRoot: bots.url });
    channels.speechService = new SpeechService({
      connections: h.graph.assistantSpeech,
      transcriber: new DeepgramTranscriber({
        fetchImpl: (url, init) =>
          fetch(String(url).replace("https://api.deepgram.com/v1", deepgram.url), init),
      }),
    });
    const connection = h.connection();
    await h.start();
    h.note("gateway ready");

    // The scripted model: the voice turn creates a reminder due in a few seconds and
    // confirms it; the reminder's own run returns its text verbatim.
    let dueAt;
    h.model.reply = (request) => {
      const turn = turnOf(request);
      if (turn.user.includes("Deliver this reminder")) return { text: reminderText };
      if (!turn.user.includes("E2E_VOICE")) return { text: "Okay." };
      if (!turn.results.length && turn.tools.includes("agentpier_reminder")) {
        // Due soon, with room for the turn to create it on a loaded runner.
        dueAt = new Date(Date.now() + 15000).toISOString();
        return {
          tool: {
            name: "agentpier_reminder",
            arguments: {
              action: "create",
              name: "Water the plants",
              message: reminderText,
              schedule: { kind: "at", at: dueAt },
            },
          },
        };
      }
      return { text: "E2E_CONFIRMED I will remind you." };
    };

    // The owner sets up the agent, speech and the bot through AgentPier's routes.
    const agent = await h.http("POST", "/assistants", {
      name: "Home",
      instructions: "Help the owner.",
      model: { connectionId: connection.id, modelId: "fixture-model" },
      capabilities: { memory: false, reminders: true },
    });
    await h.http("PUT", "/assistant-speech", {
      apiKey: "dg-fixture-key",
      language: "en",
      revision: 0,
    });
    const created = await h.http("POST", "/assistant-channels", {
      assistantId: agent.id,
      token,
      language: "en",
    });
    const { code } = await h.http("POST", `/assistant-channels/${created.id}/pair`, {
      revision: created.revision,
    });
    channels.start();
    bots.text(token, owner, `/start ${code}`);
    const paired = await h.until(async () => {
      const listed = await h.http("GET", "/assistant-channels");
      const channel = listed.channels.find((c) => c.id === created.id);
      return channel?.enabled && String(channel.chatId) === owner.id && channel;
    }, "pairing");
    h.note("bot paired");

    // The voice note.
    const sentBefore = bots.sent(token, owner.id).length;
    bots.voice(token, owner, "voice-e2e", Buffer.alloc(4096, 7));
    await h.until(() => deepgram.requests.length, "transcription request");
    h.note("Deepgram transcription requested");
    assert.equal(deepgram.requests[0].authorization, "Token dg-fixture-key");
    assert.match(deepgram.requests[0].url, /language=en/);
    const voiceTurn = await h.until(
      () => h.model.requests.find((r) => turnOf(r).user.includes("E2E_VOICE")),
      "the transcript reaches the agent",
    );
    h.note("transcript reached the model");
    assert.ok(turnOf(voiceTurn).tools.includes("agentpier_reminder"));
    const reminders = await h.until(async () => {
      const listed = await h.http("GET", `/assistants/${agent.id}/reminders`);
      return listed.reminders.length && listed.reminders;
    }, "reminder created");
    h.note("native reminder created");
    t.diagnostic(`reminder=${JSON.stringify(reminders[0])}`);
    assert.equal(reminders[0].name, "Water the plants");
    assert.equal(reminders[0].telegram, true, "asked from Telegram, delivered there too");
    assert.deepEqual(reminders[0].schedule, { kind: "at", at: dueAt });
    const confirmation = await h.until(
      () =>
        bots
          .sent(token, owner.id)
          .slice(sentBefore)
          .find((c) => String(c.params.text).includes("E2E_CONFIRMED")),
      "confirmation in Telegram",
    );
    h.note("confirmation sent to Telegram");
    t.diagnostic(`confirmation=${JSON.stringify(confirmation.params.text)}`);

    // The reminder fires at its time and comes back through Telegram and the chat.
    const delivered = await h.until(
      () =>
        bots
          .sent(token, owner.id)
          .find((c) => String(c.params.text).includes(reminderText)),
      "reminder delivered to Telegram",
    );
    h.note("reminder delivered to Telegram");
    assert.ok(Date.now() >= Date.parse(dueAt), "not before it was due");
    const run = h.model.requests.find((r) =>
      turnOf(r).user.includes("Deliver this reminder"),
    );
    assert.ok(run, "the reminder ran as its own native turn");
    assert.deepEqual(turnOf(run).tools, [], "a reminder run gets no tools");
    t.diagnostic(`telegram=${JSON.stringify(delivered.params.text)}`);
    const chat = await h.until(async () => {
      const history = await h.history(paired.conversationId);
      return (
        history.messages.some((m) => String(m.text).includes(reminderText)) && history
      );
    }, "reminder in the chat");
    h.note("reminder shown in the chat");
    const shown = chat.messages.find((m) => String(m.text).includes(reminderText));
    t.diagnostic(`chat message=${JSON.stringify(shown)}`);
    assert.equal(shown.role, "assistant");
    assert.ok(
      chat.messages.some(
        (m) => m.role === "user" && String(m.text).includes("E2E_VOICE"),
      ),
      "the transcribed note is in the chat",
    );
    await h.until(() => h.pushes.length, "push notice");
    assert.deepEqual(
      h.pushes.map((p) => [p.kind, p.conversationId]),
      [["agent-routine", paired.conversationId]],
    );
    t.diagnostic(`events=${JSON.stringify(h.events)}`);
  },
);
