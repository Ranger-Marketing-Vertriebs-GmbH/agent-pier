// Shared setup of the agentpier_share_file integration tests.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { ChannelService } from "../../server/features/assistant-channels/channel-service.js";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";
import { fakeBotApi } from "./assistant-telegram-fakes.js";

export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
export const token = "123456:abcdefghijklmnopqrstuv";

/**
 * One agent with its chat and a paired Telegram channel (fake Bot API), the real
 * team plugin tool talking to a real bridge over HTTP, and the AssistantService.
 */
export async function shareFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-share-files-"));
  const workspaces = path.join(dataDir, "workspaces");
  fs.mkdirSync(workspaces);
  const store = new AssistantStore({ dataDir });
  let history = [];
  const client = new EventEmitter();
  client.ready = true;
  client.subscribe = (f) => {
    client.on("event", f);
    return () => client.off("event", f);
  };
  client.call = async (method, params) => {
    if (method === "sessions.send") return { runId: params.idempotencyKey };
    if (method === "chat.history") return { messages: history, hasMore: false };
    if (method === "sessions.messages.subscribe") return {};
    if (method === "agent.wait") return { status: "timeout" };
    if (method === "sessions.describe") return { session: {} };
    assert.fail(method);
  };
  const runtime = new EventEmitter();
  runtime.client = client;
  runtime.close = async () => {};
  runtime.setState = () => {};
  runtime.status = () => ({ availability: "ready" });
  const service = new AssistantService({
    store,
    runtime,
    models: {
      listCapabilities: () => [],
      resolve: () => ({ release() {} }),
      imageInput: () => true,
    },
    config: { apply: async () => {}, reset() {}, workspaces },
  });
  // The trusted turn contexts TeamStore records in the app.
  const contexts = new Map();
  service.teams = {
    assertMemberTurn() {},
    close() {},
    store: {
      context: (id) => contexts.get(id) || { kind: "unknown" },
      recordContext: (id, context) => contexts.set(id, context),
      transaction: (fn) => service.attachments.transaction(fn),
    },
  };
  const audit = [];
  service.audit = { append: (event) => audit.push(event) };
  const api = await fakeBotApi({ [token]: { id: 123456, username: "fixture_bot" } });
  const channels = new ChannelService({
    dataDir,
    assistants: service,
    speech: new SpeechConnections({ dataDir }),
    clientFactory: (secret) => new TelegramClient({ token: secret, apiRoot: api.url }),
  });
  service.shares.channels = channels;
  const bridge = new TeamBridge({ assistants: service, teams: service.teams });
  const connection = await bridge.start();
  t.after(async () => {
    await bridge.close();
    await channels.close();
    await service.close();
    await api.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const agent = store.createAssistant({
    name: "Lead",
    model: { connectionId: "c", modelId: "vision" },
  });
  const chat = store.saveConversation({
    assistantId: agent.id,
    runtimeSessionKey: "lead",
  });
  const created = channels.store.create({
    assistantId: agent.id,
    conversationId: chat.id,
    botId: 123456,
    username: "fixture_bot",
    token,
    language: "en",
  });
  const pair = channels.store.pairing(created.id, created.revision);
  channels.store.acceptPair(created.id, {
    chat: { id: 42, type: "private" },
    from: { id: 42, is_bot: false },
    text: `/start ${pair.code}`,
  });
  const channel = channels.store.get(created.id);
  // The installed plugin's tool, talking to the bridge over HTTP.
  const tools = [];
  plugin.register({
    pluginConfig: connection,
    registerTool: (factory, options) => tools.push({ factory, options }),
    on() {},
  });
  const tool = (profile, conversation) =>
    tools
      .find((entry) => entry.options.name === "agentpier_share_file")
      .factory.create({
        agentId: profile.runtimeAgentId,
        sessionKey: conversation.runtimeSessionKey,
        assertInvocationCurrent() {},
      });
  const file = (profile, name, body) => {
    const target = path.join(workspaces, profile.id, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  const turn = async (conversation, key, context = { kind: "owner" }) => {
    const sent = await service.send(
      conversation.id,
      { clientRequestId: key, text: "Send me the chart" },
      context,
    );
    return sent.attempt;
  };
  const deliver = () =>
    channels.teamOutbox.process(channel.id, new AbortController().signal);
  return {
    service,
    store,
    channels,
    channel,
    api,
    audit,
    agent,
    chat,
    tool,
    file,
    turn,
    deliver,
    workspaces,
    dataDir,
    connection,
    shares: path.join(dataDir, "shares"),
    setHistory: (h) => (history = h),
  };
}

export const run = async (tool, input) =>
  JSON.parse((await tool.execute(`call-${Math.random()}`, input)).content[0].text);
