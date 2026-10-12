import test from "node:test";
import assert from "node:assert/strict";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";
import {
  applyTelegram,
  configuredAgents,
  deepgramBaseUrl,
  telegramEligible,
  telegramSections,
  telegramSnapshot,
} from "../../server/features/assistants/openclaw-config/telegram-senders.js";
import {
  isLockedPath,
  lockedPaths,
} from "../../server/features/assistants/openclaw-config/locked-core.js";

// Verified against OpenClaw 2026.9.8 by
// tests/integration/assistant-telegram-senders-contract.test.js.
const paths = { workspaces: "/w", logs: "/l" };
const profile = (id, extra = {}) => ({
  id,
  runtimeAgentId: `ap-${id}`,
  capabilities: { memory: false, reminders: false },
  ...extra,
});
const account = (assistantId, people = ["111"], extra = {}) => ({
  assistantId,
  botId: `9${assistantId.length}`,
  token: `12345:${assistantId}-token-abcdefghijklmnopqrstuvwxyz`,
  people,
  ...extra,
});
const speech = { apiKey: "dg-key", model: "nova-3", language: "auto" };
const teams = (profiles, telegram) => ({
  directory: "/plugin",
  connection: { url: "http://127.0.0.1:1", token: "bridge" },
  hostMaxConcurrent: 4,
  native: { token: "hook" },
  profiles,
  telegram,
});
const bare = (profiles, telegram) =>
  compileOpenClawConfig({
    paths,
    port: 1234,
    token: "t",
    teams: teams(profiles, telegram),
  });
// A configuration that already holds the agents' entries, as after their first apply.
const seeded = (profiles) => {
  const config = bare(profiles);
  config.agents.entries = Object.fromEntries(
    profiles.map((p) => [p.runtimeAgentId, { id: p.runtimeAgentId }]),
  );
  return config;
};
const compile = (profiles, telegram, existing = seeded(profiles)) =>
  compileOpenClawConfig({
    existing: structuredClone(existing),
    paths,
    port: 1234,
    token: "t",
    teams: teams(profiles, telegram),
    telegram,
  });

test("eligible agents: personal, not archived, without shell", () => {
  assert.equal(telegramEligible(profile("a")), true);
  assert.equal(telegramEligible(profile("a", { shell: "off" })), true);
  assert.equal(telegramEligible(profile("a", { shell: "approval" })), false);
  assert.equal(telegramEligible(profile("a", { shell: "full" })), false);
  assert.equal(telegramEligible(profile("a", { archivedAt: "2026-01-01" })), false);
  assert.equal(telegramEligible(profile("a", { teamMemberId: "m" })), false);
  assert.equal(
    telegramEligible(profile("a", { teamMemberId: "m", lifetime: "permanent" })),
    true,
  );
  assert.equal(telegramEligible({ id: "x" }), false);
});

test("without native Telegram bots nothing is compiled and stale surfaces are removed", () => {
  const stale = seeded([profile("a")]);
  Object.assign(stale, {
    channels: { telegram: { botToken: "x" } },
    bindings: [{ agentId: "ap-a", match: { channel: "telegram" } }],
    session: { dmScope: "main" },
    commands: { restart: true, bash: true },
    approvals: { exec: { enabled: true, targets: [{ channel: "telegram", to: "1" }] } },
    accessGroups: { owners: { type: "message.senders", members: {} } },
  });
  stale.models = { providers: { deepgram: { apiKey: "old" }, keep: { apiKey: "k" } } };
  const config = compile([profile("a")], { accounts: [], speech }, stale);
  assert.deepEqual(config.channels, {});
  for (const key of ["bindings", "session", "commands", "approvals", "accessGroups"])
    assert.equal(config[key], undefined, key);
  assert.equal(config.tools.agentToAgent, undefined);
  assert.equal(config.tools.media, undefined);
  assert.ok(!config.plugins.allow.includes("telegram"));
  assert.deepEqual(config.models.providers, { keep: { apiKey: "k" } });
});

test("one bot per agent: an allowlisted account, its binding and per-sender sessions", () => {
  const profiles = [profile("a"), profile("b"), profile("c")];
  const config = compile(profiles, {
    accounts: [account("a", ["111", "222"]), account("b", ["333"])],
    speech: null,
  });
  const telegram = config.channels.telegram;
  assert.equal(telegram.enabled, true);
  // Nothing reaches the agents unless an account admits it.
  assert.equal(telegram.dmPolicy, "disabled");
  assert.equal(telegram.groupPolicy, "disabled");
  assert.equal(telegram.configWrites, false);
  assert.deepEqual(Object.keys(telegram.accounts), ["ap-a", "ap-b"]);
  assert.equal(telegram.defaultAccount, "ap-a");
  assert.deepEqual(telegram.accounts["ap-a"], {
    enabled: true,
    botToken: account("a").token,
    dmPolicy: "allowlist",
    allowFrom: ["111", "222"],
    groupPolicy: "disabled",
    configWrites: false,
    execApprovals: { enabled: false },
  });
  assert.equal(telegram.apiRoot, undefined);
  assert.deepEqual(config.bindings, [
    { agentId: "ap-a", match: { channel: "telegram", accountId: "ap-a" } },
    { agentId: "ap-b", match: { channel: "telegram", accountId: "ap-b" } },
  ]);
  assert.deepEqual(config.session, { dmScope: "per-account-channel-peer" });
  assert.deepEqual(config.commands, {
    native: false,
    nativeSkills: false,
    bash: false,
    config: false,
    mcp: false,
    plugins: false,
    debug: false,
    restart: false,
    allowFrom: { telegram: [] },
  });
  assert.equal(config.approvals, undefined);
  assert.equal(config.accessGroups, undefined);
  assert.deepEqual(config.tools.agentToAgent, { enabled: false });
  // Without a speech key voice notes stay untranscribed: no local fallback either.
  assert.deepEqual(config.tools.media, { audio: { enabled: false } });
  assert.ok(config.plugins.allow.includes("telegram"));
  assert.ok(!config.plugins.allow.includes("deepgram"));
  assert.equal(config.models?.providers?.deepgram, undefined);
  // The team plugin and everything else the start compiles stay as they were.
  assert.ok(config.plugins.allow.includes("agentpier-teams"));
});

test("voice notes use Deepgram with the speech settings' key", () => {
  const config = compile([profile("a")], {
    accounts: [account("a")],
    speech: { apiKey: "dg-key", model: "nova-3", language: "de" },
  });
  assert.deepEqual(config.tools.media, {
    models: [
      { provider: "deepgram", model: "nova-3", language: "de", capabilities: ["audio"] },
    ],
    audio: { enabled: true },
  });
  assert.deepEqual(config.models.providers.deepgram, {
    apiKey: "dg-key",
    baseUrl: deepgramBaseUrl,
    models: [],
  });
  assert.ok(config.plugins.allow.includes("deepgram"));
  // "auto" leaves the language to Deepgram.
  const auto = compile([profile("a")], { accounts: [account("a")], speech });
  assert.equal(auto.tools.media.models[0].language, undefined);
});

test("ineligible agents and accounts without people are left out", () => {
  const profiles = [
    profile("shell", { shell: "approval" }),
    profile("archived", { archivedAt: "2026-01-01" }),
    profile("empty"),
    profile("ok"),
  ];
  const sections = telegramSections({
    profiles,
    telegram: {
      accounts: [
        account("shell"),
        account("archived"),
        account("empty", []),
        account("unknown"),
        account("ok"),
      ],
      speech: null,
    },
  });
  assert.deepEqual(Object.keys(sections.accounts), ["ap-ok"]);
  assert.deepEqual(sections.skipped, ["archived", "empty", "shell", "unknown"]);
  // An agent with shell never gets an account, whatever the store says.
  const config = compile(profiles, { accounts: [account("shell")], speech: null });
  assert.deepEqual(config.channels, {});
});

test("a bot waits for its agent's Gateway entry: OpenClaw refuses unknown agents", () => {
  const telegram = { accounts: [account("a")], speech: null };
  const fresh = bare([profile("a")], telegram);
  assert.deepEqual(fresh.channels, {});
  assert.equal(fresh.bindings, undefined);
  const sections = telegramSections({
    profiles: [profile("a")],
    telegram,
    agents: configuredAgents({ agents: { list: [{ id: "main" }] } }),
  });
  assert.deepEqual(sections.skipped, ["a"]);
  assert.deepEqual(
    [...configuredAgents({ agents: { entries: { "ap-a": {}, x: { id: "ap-b" } } } })],
    ["ap-a", "ap-b"],
  );
  assert.deepEqual([...configuredAgents(null)], []);
});

test("test seams: a Bot API root and a private Deepgram endpoint", () => {
  const config = compile([profile("a")], {
    accounts: [account("a")],
    speech,
    apiRoot: "http://127.0.0.1:9",
    deepgram: { baseUrl: "http://127.0.0.1:8/v1" },
  });
  assert.equal(config.channels.telegram.apiRoot, "http://127.0.0.1:9");
  assert.deepEqual(config.models.providers.deepgram, {
    apiKey: "dg-key",
    baseUrl: "http://127.0.0.1:8/v1",
    request: { allowPrivateNetwork: true },
    models: [],
  });
});

test("only the native team configuration compiles Telegram", () => {
  const telegram = { accounts: [account("a")], speech: null };
  const plain = compileOpenClawConfig({ paths, port: 1, token: "t", telegram });
  assert.deepEqual(plain.channels, {});
  assert.equal(plain.bindings, undefined);
});

test("snapshots are secret-free and change with what the start compiles", () => {
  const profiles = [profile("a")];
  const telegram = { accounts: [account("a", ["111"])], speech };
  const snapshot = telegramSnapshot(telegramSections({ profiles, telegram }));
  assert.deepEqual(snapshot.accounts, ["ap-a"]);
  assert.equal(snapshot.voice, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /token|dg-key/);
  const same = telegramSnapshot(telegramSections({ profiles, telegram }));
  assert.equal(same.signature, snapshot.signature);
  for (const changed of [
    { accounts: [account("a", ["111", "222"])], speech },
    { accounts: [account("a", ["111"], { token: "12345:other" })], speech },
    { accounts: [account("a", ["111"])], speech: { ...speech, apiKey: "new" } },
    { accounts: [account("a", ["111"])], speech: null },
    { accounts: [], speech },
  ])
    assert.notEqual(
      telegramSnapshot(telegramSections({ profiles, telegram: changed })).signature,
      snapshot.signature,
    );
});

test("applyTelegram keeps a configuration without a plugin allow list untouched", () => {
  const config = { tools: { allow: [] }, plugins: { slots: { memory: "none" } } };
  applyTelegram(config, telegramSections({ profiles: [], telegram: undefined }));
  assert.deepEqual(config, {
    tools: { allow: [] },
    plugins: { slots: { memory: "none" } },
  });
});

test("the channel surfaces are locked against overrides", () => {
  for (const target of [
    "bindings",
    "session",
    "session.dmScope",
    "commands",
    "commands.restart",
    "approvals",
    "approvals.exec",
    "accessGroups",
    "models.providers.deepgram",
    "models.providers.deepgram.apiKey",
  ])
    assert.equal(isLockedPath(target), true, target);
  assert.ok(lockedPaths.includes("channels"));
  assert.equal(isLockedPath("models.providers.x"), false);
});
