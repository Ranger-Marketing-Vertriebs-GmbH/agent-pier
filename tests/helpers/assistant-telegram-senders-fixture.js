import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChannelService } from "../../server/features/assistant-channels/channel-service.js";
import { TelegramSenders } from "../../server/features/assistant-channels/telegram-senders.js";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import {
  telegramSections,
  telegramSnapshot,
} from "../../server/features/assistants/openclaw-config/telegram-senders.js";

export const token = (n) => `${n}:fixture-token-abcdefghijklmnopqrstuvwxyz`;
export const people = [
  { id: "111", name: "Alice" },
  { id: "222", name: "Bob" },
];

/**
 * TelegramSenders over real stores in a temporary directory; Telegram and the
 * Gateway are simulated: `bots` maps token → getMe identity, `h.runtime` is the
 * running Gateway (ready with a Telegram snapshot, or stopped).
 */
export function fixture(t) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tg-senders-")));
  const store = new AssistantStore({ dataDir });
  const speech = new SpeechConnections({ dataDir });
  const bots = new Map([
    [token(1), { id: 1001, username: "agent_one_bot" }],
    [token(2), { id: 1002, username: "agent_two_bot" }],
    [token(3), { id: 1003, username: "owner_pier_bot" }],
  ]);
  const clientFactory = (value) => ({
    identity: async () => {
      if (!bots.has(value))
        throw Object.assign(Error("x"), { code: "TELEGRAM_REJECTED" });
      return bots.get(value);
    },
    call: async () => [],
  });
  const runtime = { client: null, telegram: null, telegramStarting: null, calls: [] };
  // Assistant ids bound to a stdio MCP server.
  const stdio = new Set();
  // Runtime agent ids missing from openclaw.json (never created in the Gateway).
  const unconfigured = new Set();
  const assistants = {
    store,
    runtime,
    changed() {},
    openConversation: async () => ({ id: "c" }),
  };
  const channels = new ChannelService({
    dataDir,
    assistants,
    speech,
    clientFactory,
  });
  const audit = [];
  const restarts = [];
  const synchronization = {
    async restartGateway(operation) {
      restarts.push(true);
      const result = await operation();
      h.start();
      return result;
    },
  };
  const senders = new TelegramSenders({
    store: channels.nativeBots,
    assistants,
    speech,
    synchronization,
    audit: { append: (entry) => audit.push(entry) },
    clientFactory,
    stdioAgents: () => stdio,
    // Every agent of the store has its Gateway entry, unless a test removes it.
    configured: () =>
      new Set(
        store
          .listAssistants()
          .map((p) => p.runtimeAgentId)
          .filter((id) => !unconfigured.has(id)),
      ),
    warn: () => {},
  });
  t.after(() => {
    channels.store.close();
    speech.close();
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const h = {
    dataDir,
    store,
    speech,
    channels,
    senders,
    runtime,
    audit,
    restarts,
    stdio,
    unconfigured,
    // An agent the Gateway already runs (applied once).
    agent(name = "Home", extra = {}) {
      const created = store.createAssistant({
        name,
        model: { connectionId: "c", modelId: "m" },
        ...extra,
      });
      store.markEffective(created.id, created.revision);
      return store.getAssistant(created.id);
    },
    // A Gateway that answers and was started with what the store compiles now.
    start(accounts = {}) {
      runtime.client = {
        ready: true,
        call: async (method) => {
          runtime.calls.push(method);
          return { channelAccounts: { telegram: Object.values(accounts) } };
        },
      };
      runtime.telegram = h.snapshot();
      runtime.telegramStarting = runtime.telegram;
    },
    // A Gateway that compiled the store as it is now and has not answered yet.
    starting() {
      runtime.client = { ready: false };
      runtime.telegram = null;
      runtime.telegramStarting = h.snapshot();
    },
    snapshot() {
      const profiles = store.listAssistants();
      return telegramSnapshot(
        telegramSections({
          profiles,
          telegram: senders.inputs(),
          agents: senders.configured(),
          stdio,
        }),
      );
    },
  };
  return h;
}
