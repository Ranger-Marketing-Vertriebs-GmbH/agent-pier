import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { hermesChannels } from "../../server/features/assistants/runtimes/hermes/hermes-channels.js";
import { fakeHermesSupervisor } from "../helpers/hermes-fake-gateway.js";
import {
  applyOwnBots,
  ownBotRead,
  ownBotStatus,
} from "../../server/features/assistant-channels/telegram-senders-own.js";

// AGENTPIER-341: an agent's own Telegram bot for other people on Hermes.

const profile = (fields = {}) => ({
  id: "a1",
  name: "Helper",
  runtime: "hermes",
  runtimeAgentId: "ap-a1",
  revision: 1,
  shell: "off",
  capabilities: { memory: true },
  ...fields,
});
const bot = {
  token: "123:bot-token",
  tokenRevision: 1,
  people: ["1001"],
  speech: { apiKey: "dg-key", model: "nova-3", language: "auto" },
};
const home = (fields, channelBot, existing) =>
  compileHome(desiredAgent(profile(fields), { channelBot }), { existing });

test("a bot compiles Hermes's Telegram adapter, its access rules and Deepgram", () => {
  const compiled = home(
    {},
    { ...bot, apiRoot: "http://127.0.0.1:9", deepgram: "http://127.0.0.1:8/v1" },
  );
  const config = readHermesConfig(compiled.files["config.yaml"]);
  const extra = config.platforms.telegram.extra;
  assert.equal(config.platforms.telegram.enabled, true);
  assert.deepEqual(extra.allow_from, ["1001"]);
  assert.equal(extra.dm_policy, "allowlist");
  // Groups: a chat list nobody's chat is on; no /sethome prompt.
  assert.deepEqual(extra.allowed_chats, ["0"]);
  assert.equal(extra.guest_mode, false);
  assert.equal(config.platforms.telegram.home_channel.chat_id, "0");
  assert.deepEqual(extra.fallback_ips, ["149.154.167.220"]);
  assert.deepEqual(extra.allow_admin_from, ["0"]);
  assert.equal(extra.base_url, "http://127.0.0.1:9/bot");
  assert.equal(extra.base_file_url, "http://127.0.0.1:9/file/bot");
  assert.equal(config.stt.provider, "agentpier-deepgram");
  assert.deepEqual(config.stt["agentpier-deepgram"], {
    model: "nova-3",
    language: "auto",
    keyterms: ["AgentPier", "Helper"],
    base_url: "http://127.0.0.1:8/v1",
  });
  assert.deepEqual(config.plugins.enabled, ["agentpier-deepgram"]);
  for (const locked of ["session_search", "connections"])
    assert.ok(config.agent.disabled_toolsets.includes(locked), locked);
  // Secrets only in .env, never in config.yaml.
  assert.match(compiled.files[".env"], /TELEGRAM_BOT_TOKEN='123:bot-token'/);
  assert.match(compiled.files[".env"], /AUXILIARY_AGENTPIER_DEEPGRAM_API_KEY='dg-key'/);
  assert.doesNotMatch(compiled.files["config.yaml"], /bot-token|dg-key/);
  assert.ok(compiled.files["plugins/agentpier-deepgram/__init__.py"]);
});

test("without a key, people or eligibility nothing runs; an unknown bot is left alone", () => {
  const silent = home({}, { ...bot, speech: null });
  const config = readHermesConfig(silent.files["config.yaml"]);
  assert.equal(config.platforms.telegram.enabled, true);
  assert.deepEqual(config.stt, { enabled: false });
  assert.deepEqual(config.plugins.enabled, []);
  assert.ok(silent.remove.includes("plugins/agentpier-deepgram"));
  assert.doesNotMatch(silent.files[".env"], /DEEPGRAM/);

  // A removed bot (null), nobody allowed, or shell on: the adapter and secrets go.
  const before = home({}, bot).files;
  for (const [fields, channelBot] of [
    [{}, null],
    [{}, { ...bot, people: [] }],
    [{ shell: "approval" }, bot],
  ]) {
    const next = home(fields, channelBot, before);
    const c = readHermesConfig(next.files["config.yaml"]);
    assert.equal(c.platforms?.telegram, undefined);
    assert.deepEqual(c.stt, { enabled: false });
    assert.doesNotMatch(next.files[".env"] || "", /TELEGRAM_BOT_TOKEN|DEEPGRAM/);
    assert.ok(!c.agent.disabled_toolsets.includes("session_search"));
  }
  // Unknown (a start without an apply): no Telegram or stt key is touched.
  const bare = home({}, undefined, before);
  assert.equal(bare.files[".env"], undefined);
  assert.equal(
    readHermesConfig(bare.files["config.yaml"]).platforms.telegram.enabled,
    true,
  );
});

test("the channels sub-port reports the adapter from Hermes's runtime record", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-channels-"));
  const supervisor = fakeHermesSupervisor({ agentId: "ap-a1" });
  supervisor.agentPaths = () => ({ hermesHome: dir });
  const channels = hermesChannels(supervisor);
  await supervisor.start();
  const record = (platform) =>
    fs.writeFileSync(
      path.join(dir, "gateway_state.json"),
      JSON.stringify({ platforms: platform ? { telegram: platform } : {} }),
    );
  record(null);
  assert.deepEqual(await channels.status(), { channelAccounts: { telegram: [] } });
  record({ state: "connected" });
  assert.deepEqual((await channels.status()).channelAccounts.telegram, [
    { accountId: "ap-a1", running: true, connected: true, lastError: null },
  ]);
  record({ state: "fatal", error_code: "telegram_token_invalid" });
  assert.equal(
    (await channels.status()).channelAccounts.telegram[0].lastError,
    "telegram_token_invalid",
  );
  await supervisor.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the bot store reads into the agent's apply; saves apply its own set", async () => {
  const agent = profile();
  const applied = [];
  const senders = {
    store: {
      compiled: () => [
        {
          assistantId: "a1",
          botId: "123",
          token: "123:t",
          tokenRevision: 2,
          people: ["7"],
        },
      ],
      list: () => [{ assistantId: "a1" }],
    },
    speech: {
      acquire: () => ({
        apiKey: "k",
        keyRevision: 1,
        model: "nova-3",
        language: "en",
        release() {},
      }),
    },
    apiRoot: "http://fake",
    deepgram: null,
    warn: () => {},
    stdioAgents: () => new Set(),
    sshAgents: () => new Set(),
    assistants: {
      store: {
        getAssistant: (id) => (id === "a1" ? agent : { id, runtime: "openclaw" }),
      },
      config: { apply: async (id) => applied.push(id), applying: () => false },
    },
    runtimeFor: () => ({
      host: { ready: () => true },
      channels: {
        status: async () => ({
          channelAccounts: {
            telegram: [{ running: true, connected: true, lastError: null }],
          },
        }),
      },
    }),
  };
  assert.deepEqual(ownBotRead(senders, agent), {
    token: "123:t",
    tokenRevision: 2,
    people: ["7"],
    speech: { apiKey: "k", model: "nova-3", language: "en" },
    apiRoot: "http://fake",
  });
  assert.equal(ownBotRead(senders, { id: "other" }), null);
  await applyOwnBots(senders, ["a1", "o1"]);
  assert.deepEqual(applied, ["a1"]);
  assert.deepEqual(await ownBotStatus(senders, agent, { people: [{ id: "7" }] }), {
    state: "running",
  });
  assert.deepEqual(await ownBotStatus(senders, agent, { people: [] }), {
    state: "inactive",
  });
  senders.assistants.config.applying = () => true;
  assert.deepEqual(await ownBotStatus(senders, agent, { people: [{ id: "7" }] }), {
    state: "pending",
  });
});
