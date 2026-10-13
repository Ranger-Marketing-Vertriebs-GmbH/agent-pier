import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { ChannelService } from "../../server/features/assistant-channels/channel-service.js";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";
import { SpeechService } from "../../server/features/speech/speech-service.js";
import { DeepgramTranscriber } from "../../server/features/speech/deepgram-transcriber.js";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";
import { withMessageSources } from "../../server/features/assistants/message-source.js";
import { publicMessages } from "../../server/features/assistants/conversations.js";
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
  const attemptIds = [];
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
    // Long and multi-line, with trailing whitespace: the chat must still find its turn.
    const list = `Shopping list:\n${Array.from(
      { length: 80 },
      (_, n) => `- item ${n}: ${"fresh ".repeat(6)}`,
    ).join("\n")}\n`;
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
      [4, { text: list }],
    ]) {
      const input = message(updateId, content);
      updates.push(input, input);
      await channels.ingress.poll(channel.id, signal);
      await channels.process(channel.id, signal);
      const entry = channels.ledger.list(channel.id).at(-1);
      assert.ok(entry.attemptId);
      attemptIds.push(entry.attemptId);
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
    assert.deepEqual(delivered, Array(3).fill("A useful assistant reply."));
    assert.equal(transcribed, 1);
    // The chat marks Telegram turns by their request (message-source.js): OpenClaw
    // keeps the attempt's delivery key and the sent text on each user turn.
    const conversationId = channel.conversationId;
    const requests = assistants.ledger.requests(conversationId);
    const raw = await assistants.runtime.client.call("chat.history", {
      sessionKey: assistants.store.getConversation(conversationId).runtimeSessionKey,
      limit: 100,
    });
    // The contract's service runs without teams, so the trusted context is not
    // recorded; the request's client key stands in for it here.
    const contexts = new Map(
      requests.map((r) => [
        r.id,
        assistants.teams?.store.context(r.id) || {
          kind: r.clientRequestId.startsWith("telegram:") ? "telegram" : "owner",
        },
      ]),
    );
    // The native turn key contract message-source.js relies on: each attempt's user
    // turn carries `<attempt id>:user` at the top level and in `__openclaw`, with a
    // message id, and the reply it started names the attempt as its run.
    for (const attemptId of attemptIds) {
      const key = `${attemptId}:user`;
      const at = raw.messages.findIndex((m) => m.idempotencyKey === key);
      assert.ok(at >= 0, `no user turn keyed ${key}`);
      const turn = raw.messages[at];
      assert.equal(turn.role, "user");
      assert.equal(turn.__openclaw?.idempotencyKey, key);
      assert.equal(typeof turn.__openclaw?.id, "string");
      assert.ok(turn.__openclaw.id.length > 0);
      assert.ok(
        raw.messages
          .slice(at + 1)
          .some((m) => m.role === "assistant" && m.__openclaw?.runId === attemptId),
        `no reply with runId ${attemptId}`,
      );
    }
    const turns = publicMessages(raw.messages).filter((m) => m.role === "user");
    assert.ok(turns.every((m) => m.turnKey));
    assert.equal(
      turns.filter((m) => attemptIds.includes(m.turnKey)).length,
      attemptIds.length,
    );
    const marked = withMessageSources(turns, requests, {
      attempts: assistants.ledger.attemptRequests(conversationId),
      contexts,
    });
    const sourceOf = (text) => marked.find((m) => m.text === text)?.source;
    assert.equal(sourceOf("Check your status then reply."), "telegram");
    assert.equal(sourceOf("Check your status again."), undefined);
    assert.ok(
      marked.some((m) => m.source === "telegram" && m.text.startsWith("Shopping")),
    );
    // Without the key, the text alone still finds the long turn.
    const unkeyed = withMessageSources(
      turns.map(({ turnKey: _key, ...m }) => m),
      requests,
      { contexts },
    );
    assert.equal(unkeyed.filter((m) => m.source === "telegram").length, 3);
    assert.equal(
      unkeyed.find((m) => m.text === "Check your status again.").source,
      undefined,
    );
    assert.equal(channels.ledger.list(channel.id).length, 3);
    await channels.process(channel.id, signal);
    assert.equal(delivered.length, 3);
  } finally {
    await channels.close();
  }
}
