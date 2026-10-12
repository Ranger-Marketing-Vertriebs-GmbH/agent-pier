import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createBackupKey } from "../../server/features/assistants/backup-credentials.js";
import { McpChanges } from "../../server/features/assistants/mcp-changes.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { fixture, people, token } from "../helpers/assistant-telegram-senders-fixture.js";

const keys = (h) => {
  const folder = path.join(h.dataDir, "assistants", "backup-keys");
  return fs.existsSync(folder) ? fs.readdirSync(folder) : [];
};
const backupKey = (h) =>
  createBackupKey(path.join(h.dataDir, "assistants"), randomUUID());

test("a removal while the Gateway starts takes the restart path", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  const saved = await h.senders.save(agent.id, {
    token: token(1),
    people,
    revision: null,
  });
  // The start compiled the bot and has not answered yet.
  h.starting();
  assert.equal(h.senders.differs(), false);
  await assert.rejects(h.senders.remove(agent.id, saved.bot.revision), {
    code: "ASSISTANT_RESTART_REQUIRED",
  });
  assert.ok(h.senders.store.get(agent.id), "nothing removed unconfirmed");
  // A person removed during the start as well.
  await assert.rejects(
    h.senders.save(agent.id, { people: [people[0]], revision: saved.bot.revision }),
    { code: "ASSISTANT_RESTART_REQUIRED" },
  );
  const removed = await h.senders.remove(agent.id, saved.bot.revision, {
    confirmed: true,
  });
  assert.equal(removed.bot, null);
  assert.equal(h.restarts.length, 1);
  assert.equal(removed.pending, false);
});

test("a revocation that slipped past a start restarts the Gateway once it answers", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  const saved = await h.senders.save(agent.id, {
    token: token(1),
    people,
    revision: null,
  });
  // The start read the store just before the owner removed a person.
  const started = h.snapshot();
  h.senders.store.save(agent.id, { people: [people[0]] }, saved.bot.revision);
  h.runtime.client = { ready: true, call: async () => ({}) };
  h.runtime.telegram = h.runtime.telegramStarting = started;
  assert.equal(h.senders.revoked(), true);
  // The section shows it as pending until the restart, even without a bot.
  assert.equal((await h.senders.get(agent.id)).pending, true);
  assert.equal(await h.senders.converge(), true);
  assert.equal(h.restarts.length, 1);
  assert.equal(h.senders.revoked(), false);
  // An addition alone never restarts on its own: it waits for the owner.
  const before = h.snapshot();
  const current = h.senders.store.get(agent.id);
  h.senders.store.save(agent.id, { people }, current.revision);
  h.runtime.telegram = before;
  assert.equal(h.senders.revoked(), false);
  assert.equal(await h.senders.converge(), false);
  assert.equal((await h.senders.get(agent.id)).status.state, "pending");
  // A busy Gateway refuses the restart: it is retried later.
  h.runtime.telegram = started;
  const failing = h.senders.synchronization;
  h.senders.synchronization = {
    restartGateway: async () => {
      throw Object.assign(Error("busy"), { key: "active" });
    },
  };
  h.senders.store.save(agent.id, { people: [] }, h.senders.store.get(agent.id).revision);
  assert.equal(await h.senders.converge(), false);
  assert.ok(h.senders.retry, "a retry is scheduled");
  h.senders.close();
  h.senders.synchronization = failing;
});

test("an agent in openclaw.json whose first apply never finished causes no restart loop", async (t) => {
  const h = fixture(t);
  const created = h.store.createAssistant({
    name: "Half applied",
    model: { connectionId: "c", modelId: "m" },
  });
  assert.equal(h.store.getAssistant(created.id).effectiveRevision, 0);
  await h.senders.save(created.id, { token: token(1), people, revision: null });
  // Every start compiles the bot: the agent is in the configuration.
  h.start();
  assert.ok(h.runtime.telegram.accounts.length);
  assert.equal(h.senders.revoked(), false);
  assert.equal(await h.senders.converge(), false);
  assert.equal(h.restarts.length, 0);
  assert.equal((await h.senders.get(created.id)).pending, false);
});

test("a revocation restarts once; one a restart cannot remove goes to the owner", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  const saved = await h.senders.save(agent.id, {
    token: token(1),
    people,
    revision: null,
  });
  const started = h.snapshot();
  h.senders.store.save(agent.id, { people: [people[0]] }, saved.bot.revision);
  // A restart that keeps compiling the old allowlist (it never converges).
  h.senders.synchronization = {
    restartGateway: async (operation) => {
      h.restarts.push(true);
      await operation();
      h.runtime.telegram = h.runtime.telegramStarting = started;
    },
  };
  h.runtime.client = { ready: true, call: async () => ({}) };
  h.runtime.telegram = h.runtime.telegramStarting = started;
  assert.equal(await h.senders.converge(), true);
  assert.equal(await h.senders.converge(), false);
  assert.equal(await h.senders.converge(), false);
  assert.equal(h.restarts.length, 1, "exactly one automatic restart");
  const view = await h.senders.get(agent.id);
  assert.equal(view.revocationFailed, true);
  assert.equal(view.pending, true);
  // The owner's confirmed restart starts afresh.
  await h.senders.apply({ confirmed: true });
  assert.equal(h.senders.revocation, null);
  // Busy refusals back off and then stop as well.
  const failing = Object.assign(fixture(t), {});
  const other = failing.agent();
  const first = await failing.senders.save(other.id, {
    token: token(2),
    people,
    revision: null,
  });
  failing.start();
  failing.senders.store.save(other.id, { people: [people[0]] }, first.bot.revision);
  failing.senders.maxAttempts = 2;
  failing.senders.synchronization = {
    restartGateway: async () => {
      throw Object.assign(Error("busy"), { key: "active" });
    },
  };
  assert.equal(await failing.senders.converge(), false);
  assert.ok(failing.senders.retry);
  assert.equal(await failing.senders.converge(), false);
  assert.equal(failing.senders.revocation.failed, true);
  failing.senders.close();
});

test("a bot waits for its agent's Gateway entry, then Apply now compiles it", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  h.unconfigured.add(agent.runtimeAgentId);
  h.start();
  await h.senders.save(agent.id, { token: token(1), people, revision: null });
  assert.equal((await h.senders.get(agent.id)).status.state, "inactive");
  assert.equal(h.restarts.length, 0);
  // The agent's first apply created its entry: now the bot is pending.
  h.unconfigured.delete(agent.runtimeAgentId);
  assert.equal((await h.senders.get(agent.id)).status.state, "pending");
  assert.deepEqual(await h.senders.apply({ confirmed: true }), { applied: true });
  assert.equal(h.restarts.length, 1);
});

test("only the agent concerned shows a pending change", async (t) => {
  const h = fixture(t);
  const [one, two] = [h.agent("One"), h.agent("Two")];
  const saved = await h.senders.save(one.id, { token: token(1), people, revision: null });
  h.start();
  h.senders.store.remove(one.id, saved.bot.revision);
  assert.equal((await h.senders.get(one.id)).pending, true);
  assert.equal((await h.senders.get(two.id)).pending, false);
});

test("stdio MCP servers and an own bot exclude each other", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  h.stdio.add(agent.id);
  await assert.rejects(
    h.senders.save(agent.id, { token: token(1), people, revision: null }),
    { status: 409, key: "telegramSendersStdio" },
  );
  assert.equal((await h.senders.get(agent.id)).stdio, true);
  h.stdio.clear();
  await h.senders.save(agent.id, { token: token(1), people, revision: null });
  // Binding a stdio server to the agent is refused; a remote one is not.
  const servers = new Map([
    ["s-stdio", { id: "s-stdio", transport: "stdio" }],
    ["s-http", { id: "s-http", transport: "http" }],
  ]);
  const mcp = Object.assign(Object.create(McpChanges.prototype), {
    telegramSenders: h.senders,
    servers: {
      bindings: () => [],
      get: (id) => servers.get(id),
    },
  });
  assert.throws(
    () => mcp.checkBindings(h.store.getAssistant(agent.id), ["s-stdio"], true),
    { status: 409, message: /Telegram-Bot/ },
  );
  assert.equal(mcp.checkBindings(h.store.getAssistant(agent.id), ["s-http"]), false);
  // A stdio binding that raced the save keeps the bot out of the compile.
  h.stdio.add(agent.id);
  assert.deepEqual(h.senders.desired().accounts, []);
  assert.equal((await h.senders.get(agent.id)).status.state, "inactive");
});

test("archiving an agent with its own bot is refused", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  await h.senders.save(agent.id, { token: token(1), people, revision: null });
  const service = Object.assign(Object.create(TeamService.prototype), {
    assistants: { admit: (operation) => operation(), telegramSenders: h.senders },
    store: {
      assertLifecycle: () => ({ kind: "member", assistantId: agent.id }),
      members: () => [],
    },
  });
  await assert.rejects(service.lifecycle("archive", "m1", 1), {
    status: 409,
    key: "telegramSendersArchive",
  });
});

test("token and speech key changes destroy backup keys and leave no old key live", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  const saved = await h.senders.save(agent.id, {
    token: token(1),
    people,
    revision: null,
  });
  await backupKey(h);
  await h.senders.save(agent.id, { token: token(2), revision: saved.bot.revision });
  assert.deepEqual(keys(h), [], "a replaced token destroys backup keys");
  await backupKey(h);
  // A speech key the running Gateway uses: changing it asks to restart first.
  await h.senders.saveSpeech({ apiKey: "dg-old", revision: 0 });
  assert.deepEqual(keys(h), [], "a new speech key destroys backup keys");
  h.start();
  await backupKey(h);
  const revision = h.speech.get().revision;
  await assert.rejects(h.senders.saveSpeech({ removeApiKey: true, revision }), {
    code: "ASSISTANT_RESTART_REQUIRED",
  });
  assert.equal(h.speech.get().hasSecret, true, "nothing changed unconfirmed");
  assert.equal(keys(h).length, 1);
  await h.senders.saveSpeech({ removeApiKey: true, revision }, { confirmed: true });
  assert.equal(h.speech.get().hasSecret, false);
  assert.equal(h.restarts.length, 1);
  assert.deepEqual(keys(h), []);
  assert.equal(h.runtime.telegram.voiceKey, null);
  // Model and language alone change nothing the Gateway runs without a key.
  await h.senders.saveSpeech({ language: "de", revision: h.speech.get().revision });
  assert.equal(h.restarts.length, 1);
  // Removing the bot destroys backup keys too.
  await backupKey(h);
  const current = h.senders.store.get(agent.id);
  await h.senders.remove(agent.id, current.revision, { confirmed: true });
  assert.deepEqual(keys(h), []);
});

test("without any bot a speech key change touches neither backups nor the Gateway", async (t) => {
  const h = fixture(t);
  h.start();
  await backupKey(h);
  await h.senders.saveSpeech({ apiKey: "dg-key", revision: 0 });
  assert.equal(keys(h).length, 1);
  assert.equal(h.restarts.length, 0);
});

test("an unreadable openclaw.json never stops AgentPier and alerts the owner", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  await h.senders.save(agent.id, { token: token(1), people, revision: null });
  h.start();
  const notified = [];
  h.senders.notifications = { notify: async (input) => notified.push(input) };
  const config = path.join(h.dataDir, "openclaw.json");
  fs.writeFileSync(config, "{ not json");
  h.runtime.paths = { config };
  h.senders.configured = h.senders.configuredFromFile;
  const unhandled = [];
  const listener = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));
  h.senders.ready();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(unhandled, []);
  assert.equal(await h.senders.converge(), false);
  assert.equal(h.restarts.length, 0);
  const view = await h.senders.get(agent.id);
  assert.equal(view.revocationFailed, true);
  assert.deepEqual(
    notified.map((n) => n.kind),
    ["telegram-revocation"],
    "the owner is told once",
  );
  assert.equal(notified[0].assistantId, undefined);
  h.senders.close();
});

test("the owner is notified once when the restart cap is reached", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  const saved = await h.senders.save(agent.id, {
    token: token(1),
    people,
    revision: null,
  });
  const started = h.snapshot();
  h.senders.store.save(agent.id, { people: [people[0]] }, saved.bot.revision);
  const notified = [];
  h.senders.notifications = { notify: async (input) => notified.push(input) };
  h.senders.synchronization = {
    restartGateway: async () => {
      h.restarts.push(true);
      h.runtime.telegram = h.runtime.telegramStarting = started;
    },
  };
  h.runtime.client = { ready: true, call: async () => ({}) };
  h.runtime.telegram = h.runtime.telegramStarting = started;
  await h.senders.converge();
  await h.senders.converge();
  await h.senders.converge();
  assert.equal(notified.length, 1);
  assert.equal(notified[0].kind, "telegram-revocation");
  assert.equal(notified[0].assistantId, agent.id);
});
