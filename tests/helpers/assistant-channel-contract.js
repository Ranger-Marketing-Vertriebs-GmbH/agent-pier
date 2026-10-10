import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ChannelService } from "../../server/features/assistant-channels/channel-service.js";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";
import { SpeechService } from "../../server/features/speech/speech-service.js";
import { DeepgramTranscriber } from "../../server/features/speech/deepgram-transcriber.js";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";
export async function qualifyAssistantChannels({ dataDir, assistants, assistantId }) {
  const botId = Date.now(),
    token = `${botId}:synthetic-test-token-for-contract`;
  const updates = [],
    delivered = [];
  let transcribed = 0;
  const externalFetch = async (url, options) => {
    const target = new URL(url),
      method = target.pathname.split("/").at(-1);
    if (target.hostname === "api.deepgram.com") {
      assert.equal(options.headers.Authorization, "Token synthetic-deepgram");
      transcribed++;
      return Response.json({
        results: {
          channels: [
            { alternatives: [{ transcript: "Plan dinner after checking your status." }] },
          ],
        },
      });
    }
    if (target.pathname.includes("/file/"))
      return new Response(Buffer.from("synthetic audio"));
    let result;
    if (method === "getMe") result = { id: botId, is_bot: true, username: "fixture_bot" };
    else if (method === "getWebhookInfo") result = { url: "" };
    else if (method === "getUpdates") result = updates.splice(0);
    else if (method === "getFile")
      result = { file_path: "voice/fixture.oga", file_size: 15 };
    else if (method === "sendMessage") {
      const params = JSON.parse(options.body);
      assert.equal(params.chat_id, "42");
      delivered.push(params.text);
      result = { message_id: delivered.length, chat: { id: 42 } };
    } else assert.fail(method);
    return Response.json({ ok: true, result });
  };
  const speech = new SpeechConnections({ dataDir });
  speech.save({ revision: speech.get().revision, apiKey: "synthetic-deepgram" });
  const channels = new ChannelService({
    dataDir,
    assistants,
    speech,
    clientFactory: (token) => new TelegramClient({ token, fetchImpl: externalFetch }),
  });
  channels.speechService = new SpeechService({
    connections: speech,
    transcriber: new DeepgramTranscriber({ fetchImpl: externalFetch }),
  });
  const signal = new AbortController().signal;
  try {
    const channel = await channels.create({ assistantId, token });
    const pair = await channels.pair(channel.id, channel.revision);
    const message = (n, fields) => ({
      update_id: n,
      message: {
        message_id: n,
        chat: { id: 42, type: "private" },
        from: { id: 42, is_bot: false },
        ...fields,
      },
    });
    updates.push(message(1, { text: `/start ${pair.code}` }));
    await channels.ingress.poll(channel.id, signal);
    assert.equal(channels.store.get(channel.id).chatId, "42");
    for (const [updateId, content] of [
      [2, { text: "Check your status then reply." }],
      [
        3,
        {
          voice: {
            file_id: "voice-fixture",
            file_size: 15,
            mime_type: "audio/ogg",
            duration: 2,
          },
        },
      ],
    ]) {
      const input = message(updateId, content);
      updates.push(input, input);
      await channels.ingress.poll(channel.id, signal);
      await channels.process(channel.id, signal);
      const entry = channels.ledger.list(channel.id).at(-1);
      assert.ok(entry.attemptId);
      const completion = await assistants.runtime.client.call(
        "agent.wait",
        { runId: entry.attemptId, timeoutMs: 30000 },
        { timeoutMs: 35000 },
      );
      assert.equal(completion.status, "ok");
      for (
        let n = 0;
        n < 30 && channels.ledger.get(entry.id).state !== "delivered";
        n++
      ) {
        await assistants.reconcile();
        await channels.process(channel.id, signal);
        await delay(100);
      }
      assert.equal(channels.ledger.get(entry.id).state, "delivered");
    }
    assert.deepEqual(delivered, [
      "A useful assistant reply.",
      "A useful assistant reply.",
    ]);
    assert.equal(transcribed, 1);
    assert.equal(channels.ledger.list(channel.id).length, 2);
    await channels.process(channel.id, signal);
    assert.equal(delivered.length, 2);
  } finally {
    await channels.close();
  }
}
