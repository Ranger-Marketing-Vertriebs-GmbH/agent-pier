import test from "node:test";
import assert from "node:assert/strict";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { notifyAction } from "../../server/features/assistants/assistant-action-notifications.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";

const signal = () => new AbortController().signal;
function setup(t, language) {
  const f = channelFixture(t, { language: () => language });
  f.assistants.models = { resolve: async () => ({ release() {} }) };
  f.assistants.teams = new TeamService({ assistants: f.assistants, autoStart: false });
  t.after(() => f.assistants.teams.close());
  const original = f.assistants.send;
  f.assistants.send = async (id, input, context) => {
    const sent = await original(id, input);
    f.assistants.teams.store.recordContext(sent.request.id, { ...context });
    return sent;
  };
  const sends = [];
  f.client.call = async (method, params) => {
    sends.push(params);
    return { message_id: sends.length, chat: { id: 42 } };
  };
  return { ...f, sends };
}
async function proposal(f) {
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  await f.service.ingress.dispatch(f.channel.id);
  const entry = f.service.ledger.list(f.channel.id)[0];
  f.assistants.ledger.transition(entry.attemptId, "completed");
  f.service.ledger.patch(entry.id, { state: "delivered" });
  return f.assistants.teams.propose(
    { attemptId: entry.attemptId, toolCallId: "call", assertCurrent() {} },
    {
      objective: "Plan",
      members: [{ name: "Planner", role: "Plan", assignment: "Make a plan" }],
    },
  );
}

for (const language of ["en", "de"]) {
  test(`team approval notices and buttons follow the channel language ${language}`, async (t) => {
    const f = setup(t, language);
    const m = serverCatalogs[language].assistants;
    await proposal(f);
    await f.service.teamOutbox.transfer();
    const [notice] = f.service.outbox.all(f.channel.id);
    assert.ok(notice.parts[0].text.startsWith(m.teamApproval("Plan", 1)));
    assert.deepEqual(
      notice.actions.map((a) => a.label),
      [m.teamApprove, m.teamDecline],
    );
    await f.service.teamOutbox.process(f.channel.id, signal());
    const keyboard = f.sends[0].reply_markup.inline_keyboard.flat();
    assert.deepEqual(
      keyboard.map((b) => b.text),
      [m.teamApprove, m.teamDecline],
    );
  });

  test(`action notices follow the channel language ${language}`, (t) => {
    const f = setup(t, language);
    const m = serverCatalogs[language].assistants;
    notifyAction(
      { s: { assistantChannels: f.service } },
      {
        id: "action-1",
        revision: 1,
        state: "awaiting_approval",
        assistantId: f.channel.assistantId,
        conversationId: f.channel.conversationId,
        projectName: "Project",
        payload: { action: "memory_write", title: "Note", content: "Body" },
        origin: { kind: "telegram", channelId: f.channel.id, chatId: "42", userId: "42" },
      },
      "approval",
    );
    const [notice] = f.service.outbox.all(f.channel.id);
    assert.ok(notice.parts[0].text.startsWith(m.actionApproval));
    assert.deepEqual(
      notice.actions.map((a) => a.label),
      [m.actionApprove, m.actionDecline],
    );
  });
}

test("a language change affects only notices created afterwards", async (t) => {
  const f = setup(t, "en");
  const m = serverCatalogs;
  const p = await proposal(f);
  await f.service.teamOutbox.transfer();
  const channel = f.service.store.get(f.channel.id);
  f.service.update(f.channel.id, { language: "de", revision: channel.revision });
  await f.service.serialize(async () => {});
  assert.equal(f.service.store.get(f.channel.id).language, "de");
  const [first] = f.service.outbox.all(f.channel.id);
  assert.ok(first.parts[0].text.startsWith(m.en.assistants.teamApproval("Plan", 1)));
  f.service.ingress.queueFull(f.service.store.get(f.channel.id));
  const queue = f.service.outbox.all(f.channel.id).find((n) => n.kind === "queue-full");
  assert.ok(queue.parts[0].text.startsWith(m.de.assistants.telegramQueueFull));
  // The stored notice keeps its text and a repeated transfer does not conflict.
  await f.service.teamOutbox.transfer();
  assert.equal(f.service.outbox.get(first.id).parts[0].text, first.parts[0].text);
  assert.ok(p.id);
});

test("channels without a stored language use German and the language is validated", async (t) => {
  const f = channelFixture(t);
  assert.equal(f.channel.language, "de");
  const db = f.service.store.db;
  const row = db.prepare("SELECT body FROM channels WHERE id=?").get(f.channel.id);
  const legacy = JSON.parse(row.body);
  delete legacy.language;
  db.prepare("UPDATE channels SET body=? WHERE id=?").run(
    JSON.stringify(legacy),
    f.channel.id,
  );
  assert.equal(f.service.store.get(f.channel.id).language, "de");
  const revision = f.service.store.get(f.channel.id).revision;
  for (const language of ["fr", "", null, 1])
    await assert.rejects(f.service.update(f.channel.id, { language, revision }), {
      status: assistantProblem("invalid").status,
    });
  await f.service.update(f.channel.id, { language: "en", revision });
  assert.equal(f.service.store.get(f.channel.id).language, "en");
});

test("pairing and creation capture the interface language", async (t) => {
  const f = channelFixture(t);
  const revision = f.service.store.get(f.channel.id).revision;
  const result = await f.service.pair(f.channel.id, revision, undefined, "en");
  assert.equal(result.channel.language, "en");
  await assert.rejects(
    f.service.pair(f.channel.id, result.channel.revision, undefined, "xx"),
    {
      status: 400,
    },
  );
});

test("saving only the language does not interrupt an in-flight delivery", async (t) => {
  const f = setup(t, "en");
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  await f.service.ingress.dispatch(f.channel.id);
  const entry = f.service.ledger.list(f.channel.id)[0];
  f.assistants.ledger.transition(entry.attemptId, "completed");
  f.assistants.history = async () => ({
    stale: false,
    messages: [{ role: "assistant", text: "Answer", runId: entry.attemptId }],
  });
  let release, aborted;
  const started = new Promise((resolve) => {
    f.client.call = async (method, params, signal) => {
      resolve();
      await new Promise((r) => (release = r));
      aborted = signal?.aborted;
      return { message_id: 1, chat: { id: 42 } };
    };
  });
  const sending = f.service.delivery.process(f.channel.id, new AbortController().signal);
  await started;
  const channel = f.service.store.get(f.channel.id);
  await f.service.update(f.channel.id, { language: "de", revision: channel.revision });
  release();
  await sending;
  assert.notEqual(aborted, true);
  assert.equal(f.service.ledger.get(entry.id).state, "delivered");
});

test("a channel is created with the interface language of the owner", async (t) => {
  assert.equal(channelFixture(t, { language: () => "en" }).channel.language, "en");
  const f = channelFixture(t);
  await assert.rejects(
    f.service.create({ assistantId: "x", token: "t", language: "fr" }),
    { status: 400 },
  );
});

test("a notice enqueued before its transfer was recorded survives a language switch", async (t) => {
  const f = setup(t, "en");
  const p = await proposal(f);
  const teams = f.assistants.teams.store;
  const record = teams.insert.bind(teams);
  let skip = true;
  teams.insert = (row) => {
    if (skip && String(row.id).startsWith("notification:approval:")) return;
    return record(row);
  };
  await f.service.teamOutbox.transfer();
  skip = false;
  const [first] = f.service.outbox.all(f.channel.id);
  const channel = f.service.store.get(f.channel.id);
  await f.service.update(f.channel.id, { language: "de", revision: channel.revision });
  await f.service.teamOutbox.transfer();
  assert.equal(f.service.teamOutbox.diagnostic(f.channel.id), null);
  const all = f.service.outbox
    .all(f.channel.id)
    .filter((e) => e.kind === "team-approval");
  assert.equal(all.length, 1);
  assert.equal(all[0].parts[0].text, first.parts[0].text);
  assert.ok(p.id);
});
