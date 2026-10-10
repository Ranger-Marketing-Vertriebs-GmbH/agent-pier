import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { channelFixture, telegramMessage } from "../helpers/assistant-channel-fixture.js";
import { TeamService } from "../../server/features/assistants/team-service.js";
import { notifyAction } from "../../server/features/assistants/assistant-action-notifications.js";
import { TelegramClient } from "../../server/features/assistant-channels/telegram-client.js";

const signal = () => new AbortController().signal;
const origin = "https://pier.example:8443";
function setup(t, { appUrl = origin } = {}) {
  const f = channelFixture(t, { language: () => "en" });
  if (appUrl) {
    const current = f.service.store.get(f.channel.id);
    f.service.store.update(f.channel.id, { appUrl }, current.revision);
  }
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
  const chat = `/agents/${f.channel.assistantId}/chats/${f.channel.conversationId}`;
  return { ...f, sends, chat };
}
async function completed(f, text) {
  await f.service.ingress.receive(f.channel.id, [telegramMessage(1)]);
  await f.service.ingress.dispatch(f.channel.id);
  const entry = f.service.ledger.list(f.channel.id)[0];
  f.assistants.ledger.transition(entry.attemptId, "completed");
  f.assistants.history = async () => ({
    stale: false,
    messages: [{ role: "assistant", text, runId: entry.attemptId }],
  });
  return entry;
}

test("ordinary replies carry no link and are sent as Telegram HTML", async (t) => {
  const f = setup(t);
  await completed(f, "**Dinner** is ready & warm");
  await f.service.delivery.process(f.channel.id, signal());
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].parse_mode, "HTML");
  assert.equal(f.sends[0].text, "<b>Dinner</b> is ready &amp; warm");
  assert.ok(!f.sends[0].text.split(/\s+/).some((word) => word.startsWith("http")));
});

test("review and queue notices link to the AgentPier conversation", async (t) => {
  const f = setup(t);
  const entry = await completed(f, "unused");
  f.service.ledger.patch(entry.id, { state: "delivery_failed" });
  f.service.delivery.announceReview(f.channel.id);
  f.service.ingress.queueFull(f.service.store.get(f.channel.id));
  const notices = f.service.outbox.all(f.channel.id);
  assert.deepEqual(
    notices.map((n) => n.kind),
    ["input-review", "queue-full"],
  );
  for (const notice of notices) {
    assert.equal(notice.link.url, `${origin}${f.chat}`);
    assert.match(notice.parts.at(-1).html, new RegExp(`<a href="${origin}${f.chat}">`));
    assert.match(notice.parts.at(-1).text, new RegExp(`: ${origin}${f.chat}$`));
  }
});

test("team approval and result notices link to the team task", async (t) => {
  const f = setup(t);
  const entry = await completed(f, "unused");
  f.service.ledger.patch(entry.id, { state: "delivered" });
  const p = await f.assistants.teams.propose(
    { attemptId: entry.attemptId, toolCallId: "call", assertCurrent() {} },
    {
      objective: "Plan",
      members: [{ name: "Planner", role: "Plan", assignment: "Make a plan" }],
    },
  );
  const team = `${origin}/agents/${f.channel.assistantId}/teams/${p.id}`;
  await f.service.teamOutbox.transfer();
  await f.service.teamOutbox.process(f.channel.id, signal());
  assert.equal(f.sends.length, 1);
  assert.equal(f.sends[0].parse_mode, "HTML");
  assert.ok(f.sends[0].text.includes(`<a href="${team}">`));
  assert.ok(f.sends[0].reply_markup);
  const teams = f.assistants.teams.store;
  const result = await f.assistants.send(
    p.parentConversationId,
    { clientRequestId: `team-result:${p.id}`, text: "Synthesis" },
    { kind: "team-result" },
  );
  f.assistants.ledger.transition(result.attempt.id, "completed");
  teams.write(teams.get(p.id), {
    phase: "completed",
    resultState: "completed",
    resultAttemptId: result.attempt.id,
    resultBatch: [],
  });
  f.assistants.history = async () => ({
    stale: false,
    messages: [{ role: "assistant", runId: result.attempt.id, text: "Final" }],
  });
  await f.service.teamOutbox.transfer();
  const resultNotice = f.service.outbox
    .all(f.channel.id)
    .find((n) => n.kind === "team-result");
  assert.equal(resultNotice.link.url, team);
});

test("action notices link to the conversation that requested them", (t) => {
  const f = setup(t);
  const action = {
    id: "action-1",
    revision: 1,
    state: "awaiting_approval",
    assistantId: f.channel.assistantId,
    conversationId: f.channel.conversationId,
    projectName: "Project",
    payload: { action: "memory_write", title: "Note", content: "Body" },
    origin: {
      kind: "telegram",
      channelId: f.channel.id,
      chatId: "42",
      userId: "42",
    },
  };
  notifyAction({ s: { assistantChannels: f.service } }, action, "approval");
  const [notice] = f.service.outbox.all(f.channel.id);
  assert.equal(notice.link.url, `${origin}${f.chat}`);
});

test("without a configured AgentPier address notices carry no link", async (t) => {
  const f = setup(t, { appUrl: null });
  f.service.ingress.queueFull(f.service.store.get(f.channel.id));
  const [notice] = f.service.outbox.all(f.channel.id);
  assert.equal(notice.link, null);
  assert.ok(!notice.parts.some((p) => p.html.includes("<a ")));
});

test("the AgentPier address accepts only a plain http(s) origin", (t) => {
  const f = setup(t, { appUrl: null });
  for (const invalid of [
    "javascript:alert(1)",
    "ftp://pier.example",
    "https://user:secret@pier.example",
    "https://pier.example/path",
    "https://pier.example/?q=1",
    "https://pier.example/#x",
    "not a url",
    42,
  ])
    assert.throws(
      () =>
        f.service.store.update(
          f.channel.id,
          { appUrl: invalid },
          f.service.store.get(f.channel.id).revision,
        ),
      { status: 400 },
    );
  const saved = f.service.store.update(
    f.channel.id,
    { appUrl: "https://Pier.Example:8443/" },
    f.service.store.get(f.channel.id).revision,
  );
  assert.equal(saved.appUrl, "https://pier.example:8443");
  assert.equal(saved.enabled, true);
  const cleared = f.service.store.update(f.channel.id, { appUrl: null }, saved.revision);
  assert.equal(cleared.appUrl, null);
});

test("pairing records the browser address that started it", async (t) => {
  const f = setup(t, { appUrl: null });
  const current = f.service.store.get(f.channel.id);
  const result = await f.service.pair(f.channel.id, current.revision, origin);
  assert.equal(result.channel.appUrl, origin);
  await assert.rejects(
    f.service.pair(f.channel.id, result.channel.revision, "javascript:x"),
    { status: 400 },
  );
});

test("rejected markup is resent once as plain text without repeating confirmed parts", async (t) => {
  const f = setup(t);
  await completed(f, `**${"word ".repeat(1000)}end**`);
  const calls = [];
  f.client.call = async (_method, params) => {
    calls.push(params);
    if (calls.length === 2)
      throw Object.assign(Error(), {
        code: "TELEGRAM_REJECTED",
        rejected: true,
        badRequest: true,
      });
    return { message_id: calls.length, chat: { id: 42 } };
  };
  await f.service.delivery.process(f.channel.id, signal());
  const entry = f.service.ledger.list(f.channel.id)[0];
  assert.equal(entry.state, "delivered");
  assert.equal(calls.length, 3);
  assert.equal(calls[0].parse_mode, "HTML");
  assert.equal(calls[1].parse_mode, "HTML");
  assert.equal(calls[2].parse_mode, undefined);
  assert.ok(!calls[2].text.includes("<b>"));
  assert.equal(calls[2].text, entry.parts[1].text);
  assert.equal(entry.parts[1].html, null);
  assert.deepEqual(entry.remoteMessageIds, [1, 3]);
});

test("other rejections and lost plain-text fallbacks are never replayed", async (t) => {
  const f = setup(t);
  await completed(f, "Hello");
  let calls = 0;
  f.client.call = async () => {
    calls++;
    if (calls === 1)
      throw Object.assign(Error(), {
        code: "TELEGRAM_REJECTED",
        rejected: true,
        badRequest: true,
      });
    throw Error("lost");
  };
  await f.service.delivery.process(f.channel.id, signal());
  await f.service.delivery.process(f.channel.id, signal());
  assert.equal(calls, 2);
  assert.equal(f.service.ledger.list(f.channel.id)[0].state, "delivery_uncertain");
});

test("a link target Telegram refuses falls back once to plain text with the raw URL", async (t) => {
  const f = setup(t, { appUrl: "http://127.0.0.1:4380" });
  const bodies = [];
  const client = new TelegramClient({
    token: "123456:abcdefghijklmnopqrstuv",
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      bodies.push(body);
      return body.parse_mode
        ? Response.json(
            { ok: false, error_code: 400, description: "Bad Request: wrong HTTP URL" },
            { status: 400 },
          )
        : Response.json({ ok: true, result: { message_id: 5, chat: { id: 42 } } });
    },
  });
  f.service.clientFactory = () => client;
  f.service.ingress.queueFull(f.service.store.get(f.channel.id));
  await f.service.teamOutbox.process(f.channel.id, signal());
  const [notice] = f.service.outbox.all(f.channel.id);
  assert.equal(notice.state, "delivered");
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].parse_mode, "HTML");
  assert.equal(bodies[1].parse_mode, undefined);
  assert.ok(bodies[1].text.endsWith(`: http://127.0.0.1:4380${f.chat}`));
  assert.ok(!bodies[1].text.includes("<a"));
  // Forbidden or unauthorized is not a markup problem and is not resent.
  const denied = new TelegramClient({
    token: "123456:abcdefghijklmnopqrstuv",
    fetchImpl: async () =>
      Response.json(
        { ok: false, error_code: 403, description: "Forbidden" },
        { status: 403 },
      ),
  });
  await assert.rejects(denied.call("sendMessage", {}), (e) => !e.badRequest);
});

test("saving the AgentPier address does not interrupt an in-flight delivery", async (t) => {
  const f = setup(t, { appUrl: null });
  await completed(f, "Reply");
  let release;
  const sending = new Promise((resolve) => (release = resolve));
  let started;
  const inFlight = new Promise((resolve) => (started = resolve));
  f.client.call = async () => {
    started();
    await sending;
    return { message_id: 1, chat: { id: 42 } };
  };
  const controller = new AbortController();
  f.service.workers.set(f.channel.id, {
    controller,
    task: f.service.delivery.process(f.channel.id, controller.signal),
  });
  await inFlight;
  const saved = f.service.update(f.channel.id, {
    appUrl: origin,
    revision: f.service.store.get(f.channel.id).revision,
  });
  // The save completes while the send is still pending.
  const result = await Promise.race([saved, delay(2000).then(() => "blocked")]);
  release();
  assert.notEqual(result, "blocked");
  assert.equal(result.appUrl, origin);
  await f.service.workers.get(f.channel.id).task;
  assert.equal(controller.signal.aborted, false);
  assert.equal(f.service.ledger.list(f.channel.id)[0].state, "delivered");
});
