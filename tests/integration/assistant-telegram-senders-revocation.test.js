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

test("a bot of an agent the Gateway does not know yet is pending, not inactive", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  h.start();
  await h.senders.save(
    agent.id,
    { token: token(1), people, revision: null },
    { confirmed: true },
  );
  // The restarted Gateway did not have the agent's entry (first apply pending).
  h.runtime.telegram = { ...h.runtime.telegram, accounts: [] };
  h.runtime.telegram.signature = h.senders.desired().signature;
  assert.equal((await h.senders.get(agent.id)).status.state, "pending");
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
