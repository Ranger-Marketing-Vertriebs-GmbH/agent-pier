import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ChannelService } from "../../server/features/assistant-channels/channel-service.js";
import { TelegramSenders } from "../../server/features/assistant-channels/telegram-senders.js";
import { SpeechConnections } from "../../server/features/speech/speech-connections.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import {
  telegramSections,
  telegramSnapshot,
} from "../../server/features/assistants/openclaw-config/telegram-senders.js";

const token = (n) => `${n}:fixture-token-abcdefghijklmnopqrstuvwxyz`;
const people = [
  { id: "111", name: "Alice" },
  { id: "222", name: "Bob" },
];

/**
 * TelegramSenders over real stores in a temporary directory; Telegram and the
 * Gateway are simulated: `bots` maps token → getMe identity, `h.runtime` is the
 * running Gateway (ready with a Telegram snapshot, or stopped).
 */
function fixture(t) {
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
  const runtime = { client: null, telegram: null, calls: [] };
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
      const profiles = store.listAssistants();
      runtime.telegram = telegramSnapshot(
        telegramSections({
          profiles,
          telegram: senders.inputs(),
          agents: new Set(profiles.map((p) => p.runtimeAgentId)),
        }),
      );
    },
  };
  return h;
}

test("an agent's own bot: verified token, allowed people, never the token in answers", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  const created = await h.senders.save(agent.id, {
    token: token(1),
    people,
    revision: null,
  });
  assert.equal(created.bot.username, "agent_one_bot");
  assert.equal(created.bot.botId, "1001");
  assert.deepEqual(created.bot.people, people);
  assert.equal(created.status.state, "stopped");
  assert.doesNotMatch(JSON.stringify(created), /fixture-token/);
  assert.deepEqual(h.senders.inputs().accounts, [
    { assistantId: agent.id, botId: "1001", token: token(1), people: ["111", "222"] },
  ]);
  // The people change without a new token; a removed person is gone from the start.
  const fewer = await h.senders.save(agent.id, {
    people: [people[1]],
    revision: created.bot.revision,
  });
  assert.deepEqual(fewer.bot.people, [people[1]]);
  assert.deepEqual(h.senders.inputs().accounts[0].people, ["222"]);
  // Stale revisions and malformed people are refused.
  await assert.rejects(
    h.senders.save(agent.id, { people, revision: created.bot.revision }),
    { status: 409 },
  );
  for (const bad of [
    [{ id: "abc", name: "x" }],
    [{ id: "0", name: "x" }],
    [{ id: "1", name: "" }],
    [
      { id: "1", name: "x" },
      { id: "1", name: "y" },
    ],
    [{ id: "1", name: "x", extra: true }],
  ])
    await assert.rejects(
      h.senders.save(agent.id, { people: bad, revision: fewer.bot.revision }),
      { status: 400 },
    );
  await assert.rejects(
    h.senders.save(agent.id, { token: "nope", revision: fewer.bot.revision }),
    { status: 400, key: "channelToken" },
  );
  assert.deepEqual(
    h.audit.map((e) => [e.action, e.details.kind, e.details.telegram, e.details.count]),
    [
      ["assistant.updated", "telegram", "connected", 2],
      ["assistant.updated", "telegram", "peopleRemoved", 1],
    ],
  );
  assert.doesNotMatch(JSON.stringify(h.audit), /Alice|Bob|111|fixture-token/);
});

test("one bot serves one purpose: never the AgentPier bot, never two agents", async (t) => {
  const h = fixture(t);
  const [one, two, owner] = [h.agent("One"), h.agent("Two"), h.agent("Owner")];
  // The owner's AgentPier bot first: an agent cannot take it.
  await h.channels.create({ assistantId: owner.id, token: token(3) });
  await assert.rejects(
    h.senders.save(one.id, { token: token(3), people, revision: null }),
    { status: 409, key: "telegramBotInUse" },
  );
  await h.senders.save(one.id, { token: token(1), people, revision: null });
  await assert.rejects(
    h.senders.save(two.id, { token: token(1), people, revision: null }),
    { status: 409, key: "telegramBotInUse" },
  );
  // And the AgentPier bot setup refuses a bot an agent already uses.
  await assert.rejects(h.channels.create({ assistantId: two.id, token: token(1) }), {
    status: 409,
    key: "telegramBotInUse",
  });
  assert.equal(h.channels.store.list().length, 1);
});

test("shell and an own bot exclude each other", async (t) => {
  const h = fixture(t);
  const shell = h.agent("Shell", { shell: "approval" });
  await assert.rejects(
    h.senders.save(shell.id, { token: token(1), people, revision: null }),
    { status: 409, key: "telegramSendersShell" },
  );
  const member = h.store.createAssistant({
    name: "Member",
    model: { connectionId: "c", modelId: "m" },
  });
  h.store.db
    .prepare("UPDATE assistants SET body=json_set(body,'$.teamMemberId','m') WHERE id=?")
    .run(member.id);
  await assert.rejects(
    h.senders.save(member.id, { token: token(2), people, revision: null }),
    { status: 400 },
  );
});

test("a change the running Gateway was not started with asks to restart it", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  h.start();
  await assert.rejects(
    h.senders.save(agent.id, { token: token(1), people, revision: null }),
    (error) =>
      error.code === "ASSISTANT_RESTART_REQUIRED" &&
      error.key === "telegramSendersRestartRequired" &&
      error.affected.agents.some((a) => a.id === agent.id),
  );
  assert.equal(h.senders.store.get(agent.id), null, "nothing saved unconfirmed");
  const saved = await h.senders.save(
    agent.id,
    { token: token(1), people, revision: null },
    { confirmed: true },
  );
  assert.equal(h.restarts.length, 1);
  h.start({ a: { accountId: agent.runtimeAgentId, running: true, connected: true } });
  assert.equal((await h.senders.get(agent.id)).status.state, "running");
  // Restating the same people changes nothing the Gateway runs: no restart.
  await h.senders.save(agent.id, { people, revision: saved.bot.revision });
  assert.equal(h.restarts.length, 1);
  // A new speech key leaves the running Gateway behind until the owner applies it.
  h.speech.save({ apiKey: "dg-key", revision: 0 });
  assert.equal((await h.senders.get(agent.id)).status.state, "pending");
  await assert.rejects(h.senders.apply(), { code: "ASSISTANT_RESTART_REQUIRED" });
  assert.deepEqual(await h.senders.apply({ confirmed: true }), { applied: true });
  assert.equal(h.restarts.length, 2);
  assert.deepEqual(await h.senders.apply(), { applied: false });
  // An account error is reported as a state, never as OpenClaw's text.
  h.start({ a: { accountId: agent.runtimeAgentId, running: false, lastError: "x" } });
  assert.deepEqual((await h.senders.get(agent.id)).status, { state: "error" });
  // Disconnecting asks again and removes the token.
  const current = (await h.senders.get(agent.id)).bot;
  await assert.rejects(h.senders.remove(agent.id, current.revision), {
    code: "ASSISTANT_RESTART_REQUIRED",
  });
  const removed = await h.senders.remove(agent.id, current.revision, { confirmed: true });
  assert.equal(removed.bot, null);
  assert.deepEqual(h.senders.inputs().accounts, []);
  const db = new DatabaseSync(path.join(h.dataDir, "assistants", "channels.sqlite"));
  t.after(() => db.close());
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM native_telegram_credentials").get().n,
    0,
  );
});

test("an agent's bot blocks raising its shell level", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  await h.senders.save(agent.id, { token: token(1), people, revision: null });
  const { AssistantService } =
    await import("../../server/features/assistants/assistant-service.js");
  const service = Object.create(AssistantService.prototype);
  Object.assign(service, {
    store: h.store,
    telegramSenders: h.senders,
    admit: (operation) => operation(),
  });
  await assert.rejects(
    service.update(agent.id, { shell: "approval", confirmShell: true }, agent.revision),
    { status: 409, key: "telegramSendersShell" },
  );
});
