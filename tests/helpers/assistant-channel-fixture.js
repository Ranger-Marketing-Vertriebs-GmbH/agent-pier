import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelService } from "../../server/features/assistant-channels/channel-service.js";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
// `language` is the owner's interface language, stored on the created channel.
export function channelFixture(t, { language = () => "de", ...options } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "channel-worker-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir }),
    ledger = new RequestLedger(store.db);
  const assistant = store.createAssistant({
    name: "Home",
    model: { connectionId: "test", modelId: "fixture" },
  });
  const conversation = store.saveConversation({
    assistantId: assistant.id,
    runtimeSessionKey: "session",
  });
  let ready = true;
  const sent = [];
  const assistants = {
    store,
    ledger,
    changed() {},
    runtime: {
      client: {
        get ready() {
          return ready;
        },
      },
    },
    openConversation: async () => conversation,
    send: async (id, input) => {
      if (!ready) throw Object.assign(Error(), { status: 503 });
      const request = ledger.accept(id, input);
      let attempt = ledger.attemptFor(request.id);
      if (!attempt) {
        sent.push(input);
        attempt = ledger.recordAttempt(request.id);
        ledger.transition(attempt.id, "accepted");
      }
      return { request, attempt };
    },
    history: async () => ({ messages: [], stale: false }),
  };
  const speech = new SpeechConnections({ dataDir });
  const client = {
    identity: async () => ({ id: 123456, username: "fixture_bot" }),
    call: async () => [],
  };
  const service = new ChannelService({
    dataDir,
    assistants,
    speech,
    clientFactory: () => client,
    ...options,
  });
  t.after(async () => {
    await service.close();
    store.close();
  });
  const channel = service.store.create({
    assistantId: assistant.id,
    conversationId: conversation.id,
    botId: 123456,
    username: "fixture_bot",
    token: "123456:abcdefghijklmnopqrstuv",
    language: language(),
  });
  const pair = service.store.pairing(channel.id, channel.revision);
  service.store.acceptPair(channel.id, {
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false },
    text: `/start ${pair.code}`,
  });
  return {
    dataDir,
    store,
    assistants,
    speech,
    service,
    client,
    channel: service.store.get(channel.id),
    sent,
    setReady: (v) => {
      ready = v;
    },
  };
}
export const telegramMessage = (updateId, text = "Hello") => ({
  update_id: updateId,
  message: {
    message_id: updateId,
    date: 1,
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false },
    text,
  },
});
