import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantConfig } from "../../server/features/assistants/assistant-config.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";
import { ChannelStore } from "../../server/features/assistant-channels/channel-store.js";
import { NativeTelegramStore } from "../../server/features/assistant-channels/native-telegram-store.js";
import { TelegramSenders } from "../../server/features/assistant-channels/telegram-senders.js";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";
import { assistantModelServer } from "./assistant-model-server.js";
import { fakeBotApi, fakeDeepgram } from "./assistant-telegram-fakes.js";

export const transcript = "please water the plants on friday";
const fixtureModel = { connectionId: "fixture", modelId: "fixture-model" };
// Valid arguments, so a refusal comes from AgentPier and not from tool validation.
const toolArguments = {
  agentpier_team_status: { teamId: "team-fixture" },
  agentpier_team_propose: {
    objective: "Review",
    members: [{ name: "Reviewer", role: "Review", assignment: "Review tests" }],
  },
};

/**
 * AgentPier's path for agents' own Telegram bots on an isolated Gateway in team mode,
 * wired as server/application/assistant-graph.js wires it: TelegramSenders stores the
 * bots and verifies tokens, the start compiles them, AssistantConfig applies the
 * agents. Telegram and Deepgram are loopback fakes (`h.bots`, `h.deepgram`); the
 * model calls the tool named by a `[tool:<name>]` marker in a turn's text once.
 * A confirmed change restarts the Gateway the way the maintenance restart does.
 */
export async function telegramSendersGateway(t, installed, { prefix, bots }) {
  assert.ok(path.isAbsolute(installed));
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const model = await assistantModelServer({
    tool: (input) => {
      const name = JSON.stringify(input.messages).match(/\[tool:([a-z_]+)\]/)?.[1];
      return name ? { name, arguments: toolArguments[name] || {} } : null;
    },
  });
  const botApi = await fakeBotApi(bots);
  const deepgram = await fakeDeepgram(transcript);
  const store = new AssistantStore({ dataDir: path.join(dataDir, "store") });
  const owner = path.join(dataDir, "owner-home");
  fs.mkdirSync(owner);
  const runtime = new RuntimeSupervisor({
    dataDir,
    shellOwner: () => ({ home: owner, pathPrepend: [] }),
    install: async () => ({
      version: runtimeManifest.version,
      nodePath: path.join(installed, "node/bin/node"),
      entryPath: path.join(installed, "app/node_modules/openclaw/openclaw.mjs"),
    }),
  });
  const models = {
    resolve: async () => ({
      providerId: "fixture",
      modelRef: "fixture/fixture-model",
      provider: {
        baseUrl: model.url,
        api: "openai-completions",
        apiKey: "fixture-key",
        models: [
          {
            id: "fixture-model",
            name: "Fixture",
            input: ["text"],
            contextWindow: 32768,
            maxTokens: 4096,
          },
        ],
      },
      release() {},
    }),
    listCapabilities: () => [],
  };
  const audit = [];
  const config = new AssistantConfig({
    store,
    models,
    workspaces: runtime.paths.workspaces,
    client: { call: (...args) => runtime.client.call(...args) },
    hostCapacity: () => 4,
  });
  const assistants = new AssistantService({
    store,
    runtime,
    config,
    models,
    audit: { append: (entry) => audit.push(entry) },
  });
  const teams = (assistants.teams = new TeamService({ assistants, autoStart: false }));
  const bridge = (teams.bridge = new TeamBridge({
    assistants,
    teams,
    generation: () => runtime.generation,
  }));
  Object.assign(config, {
    teamReady: () => bridge.status().ready,
    writeGuard: () => false,
    nativeReady: () => true,
    webToolsAvailable: () => ({}),
    shellPathPrepend: () => [],
    mcpTools: () => [],
    senderFacing: (assistant) =>
      !!(runtime.telegram || runtime.telegramStarting)?.accounts.includes(
        assistant.runtimeAgentId,
      ),
  });
  const channels = new ChannelStore({ dataDir: path.join(dataDir, "store") });
  const speech = new SpeechConnections({ dataDir: path.join(dataDir, "store") });
  const restarts = [];
  const senders = (assistants.telegramSenders = new TelegramSenders({
    store: new NativeTelegramStore({ db: channels.db, root: channels.root }),
    assistants,
    speech,
    audit: { append: (entry) => audit.push(entry) },
    synchronization: {
      async restartGateway(operation) {
        restarts.push(Date.now());
        await runtime.stop();
        const result = await operation();
        await runtime.start();
        return result;
      },
    },
    // Test seams: the loopback fakes instead of Telegram and Deepgram.
    apiRoot: botApi.url,
    deepgram: { baseUrl: deepgram.url },
  }));
  // As assistant-graph.js: a revocation saved during a start converges after it.
  runtime.afterReady = async () => senders.ready();
  runtime.teamConfiguration = async (descriptor) => ({
    ...provisionTeamPlugin({ paths: runtime.paths, runtimeVersion: descriptor.version }),
    connection: await bridge.start(),
    hostMaxConcurrent: 4,
    native: { token: "telegram-senders-fixture" },
    profiles: store.listAssistants(),
    telegram: senders.inputs(),
  });
  t.after(async () => {
    try {
      senders.close();
      await assistants.close();
      channels.close();
      speech.close();
      await Promise.all([model.close(), botApi.close(), deepgram.close()]);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
  const h = {
    dataDir,
    model,
    bots: botApi,
    deepgram,
    store,
    runtime,
    config,
    assistants,
    teams,
    senders,
    speech,
    audit,
    restarts,
    create: (name, extra = {}) =>
      store.createAssistant({
        name,
        instructions: "Help.",
        model: fixtureModel,
        ...extra,
      }),
    running: async () => (await runtime.client.call("config.get", {})).config,
    /** Model requests whose messages contain `marker`. */
    requests: (marker) =>
      model.requests.filter((r) => JSON.stringify(r.messages).includes(marker)),
    async until(check, label, { timeoutMs = 60000 } = {}) {
      const end = Date.now() + timeoutMs;
      for (;;) {
        const value = await check();
        if (value) return value;
        if (Date.now() > end) assert.fail(`timed out: ${label}`);
        await delay(250);
      }
    },
    /** Waits until OpenClaw polls each token at least once more. */
    async polling(...tokens) {
      const before = tokens.map((token) => botApi.polls(token));
      await h.until(
        () => tokens.every((token, i) => botApi.polls(token) > before[i]),
        "polling",
      );
    },
    async sessions(agentId) {
      const listed = await runtime.client.call("sessions.list", { agentId });
      return (listed.sessions || []).map((s) => s.key);
    },
    /** One owner turn on a new AgentPier conversation, as createConversation does. */
    async ownerTurn(agent, label, extra = "") {
      const assistant = store.getAssistant(agent.id);
      const session = await runtime.client.call("sessions.create", {
        agentId: assistant.runtimeAgentId,
        label: `AgentPier ${label}`,
      });
      const conversation = store.saveConversation({
        assistantId: agent.id,
        runtimeSessionKey: session.key,
      });
      await runtime.client.call("sessions.messages.subscribe", { key: session.key });
      const { attempt } = await assistants.send(conversation.id, {
        clientRequestId: label,
        text: `Owner question ${label} ${extra}`,
      });
      const runId = assistants.ledger.getAttempt(attempt.id).runtimeRunId || attempt.id;
      const done = await runtime.client.call(
        "agent.wait",
        { runId, timeoutMs: 60000 },
        { timeoutMs: 65000 },
      );
      return {
        status: done.status,
        tools: done.terminalReceipt?.successfulToolNames || [],
        requests: h.requests(`Owner question ${label}`),
      };
    },
  };
  return h;
}
