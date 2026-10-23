import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { fixture, people, token } from "../helpers/assistant-telegram-senders-fixture.js";

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
    {
      assistantId: agent.id,
      botId: "1001",
      token: token(1),
      tokenRevision: 1,
      people: ["111", "222"],
    },
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
  // Names and the token never appear; Telegram user ids never appear as a standalone
  // number, while generated UUIDs may contain the same digits.
  const audit = JSON.stringify(h.audit);
  assert.doesNotMatch(audit, /Alice|Bob|fixture-token/);
  assert.doesNotMatch(audit, /(?<![0-9a-f])(?:111|222)(?![0-9a-f])/i);
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

test("token and speech key changes are told by revisions, never by their values", async (t) => {
  const h = fixture(t);
  const agent = h.agent();
  const saved = await h.senders.save(agent.id, {
    token: token(1),
    people,
    revision: null,
  });
  const revision = () => h.senders.inputs().accounts[0].tokenRevision;
  assert.equal(revision(), 1);
  const fewer = await h.senders.save(agent.id, {
    people: [people[0]],
    revision: saved.bot.revision,
  });
  assert.equal(revision(), 1, "people alone keep the token revision");
  await h.senders.save(agent.id, { token: token(2), revision: fewer.bot.revision });
  assert.equal(revision(), 2);
  assert.equal(h.speech.keyRevision(), 0);
  h.speech.save({ apiKey: "dg-one", revision: 0 });
  h.speech.save({ language: "de", revision: 1 });
  assert.equal(h.speech.keyRevision(), 1, "model and language keep the key revision");
  h.speech.save({ apiKey: "dg-two", revision: 2 });
  h.speech.save({ removeApiKey: true, revision: 3 });
  assert.equal(h.speech.keyRevision(), 3);
  h.speech.save({ apiKey: "dg-three", revision: 4 });
  assert.equal(h.senders.inputs().speech.keyRevision, 4);
});

test("with a pending restart a new bot is queued, a removal still restarts at once", async (t) => {
  const h = fixture(t);
  const [one, two] = [h.agent("One"), h.agent("Two")];
  const saved = await h.senders.save(one.id, { token: token(1), people, revision: null });
  h.start();
  const queued = [];
  h.senders.synchronization.pending = {
    request: (reason, affected) => queued.push({ reason, affected }),
  };
  // An addition: saved, the restart left pending.
  const added = await h.senders.save(two.id, {
    token: token(2),
    people,
    revision: null,
  });
  assert.equal(added.bot.username, "agent_two_bot");
  assert.deepEqual(
    queued.map((entry) => entry.reason),
    ["telegram"],
  );
  assert.equal(h.restarts.length, 0);
  // A revocation: the owner confirms and the Gateway restarts at once, as before.
  await assert.rejects(h.senders.remove(one.id, saved.bot.revision), {
    code: "ASSISTANT_RESTART_REQUIRED",
  });
  assert.ok(h.senders.store.get(one.id), "nothing removed unconfirmed");
  await h.senders.remove(one.id, saved.bot.revision, { confirmed: true });
  assert.equal(h.restarts.length, 1);
  assert.equal(queued.length, 1);
});
