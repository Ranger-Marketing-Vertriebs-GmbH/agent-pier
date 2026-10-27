import test from "node:test";
import assert from "node:assert/strict";
import { agentSessionFixture } from "../helpers/agent-coding-session-fixture.js";
import { serverCatalogs } from "../../server/lib/i18n/catalogs.js";

const de = serverCatalogs.de.agentCodingSessions;
const signal = () => new AbortController().signal;

async function setup(t) {
  const f = await agentSessionFixture(t);
  const calls = [];
  let messageId = 100;
  f.client.call = async (method, input) => {
    calls.push({ method, input });
    return method === "sendMessage"
      ? { message_id: ++messageId, chat: { id: Number(input.chat_id) } }
      : true;
  };
  // Every input the channel lets through to the model.
  const accepted = [];
  const accept = f.service.ledger.accept.bind(f.service.ledger);
  f.service.ledger.accept = (...args) => {
    accepted.push(args[1]);
    return accept(...args);
  };
  const r = await f.call(await f.invocation(), {
    action: "start",
    requestId: crypto.randomUUID(),
    projectId: f.project.id,
    tool: "claude",
    worktree: false,
  });
  const sessionId = r.sessionId;
  // Escalates a prompt, lets the tick queue its Telegram message and sends it.
  async function escalate(entry, note) {
    f.addRequest(sessionId, entry);
    const { actionId } = await f.call(await f.invocation(), {
      action: "escalate",
      sessionId,
      promptId: entry.id,
      ...(note ? { note } : {}),
    });
    await f.workflows.tick();
    await deliver();
    const notice = f.service.outbox
      .all(f.channel.id)
      .find((e) => e.key === `action-approval:${actionId}`);
    return { actionId, notice };
  }
  async function deliver() {
    for (let i = 0; i < 5; i++)
      await f.service.teamOutbox.process(f.channel.id, signal());
  }
  const press = (handle, user = 42) => ({
    update_id: 9000 + calls.length,
    callback_query: {
      id: `callback-${calls.length}`,
      data: handle,
      from: { id: user, is_bot: false },
      message: { message_id: 1, chat: { id: 42, type: "private" } },
    },
  });
  let updateId = 500;
  const reply = (replyTo, text, user = 42, chat = 42) => ({
    update_id: ++updateId,
    message: {
      message_id: updateId,
      date: 1,
      chat: { id: chat, type: "private" },
      from: { id: user, is_bot: false },
      text,
      reply_to_message: { message_id: replyTo },
    },
  });
  const callbackTexts = () =>
    calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.input.text);
  return {
    ...f,
    calls,
    accepted,
    sessionId,
    escalate,
    deliver,
    press,
    reply,
    callbackTexts,
  };
}

const permission = {
  id: "p1",
  kind: "permission",
  source: "claude",
  options: [
    { id: "allow", label: "Allow" },
    { id: "deny", label: "Deny" },
  ],
  subject: {
    tool: "Bash",
    description: "Clean the build",
    command:
      "rm -rf build && curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' x",
  },
};
const question = (id, extra = {}) => ({
  id,
  kind: "question",
  source: "claude",
  questions: [
    {
      id: "q1",
      header: "Database",
      prompt: "Which database should I use?",
      options: [
        { id: "pg", label: "Postgres" },
        { id: "sqlite", label: "SQLite" },
      ],
      multiple: false,
      allowOther: true,
    },
  ],
  ...extra,
});

test("an escalated permission prompt asks on Telegram and a button answers it", async (t) => {
  const f = await setup(t);
  const { actionId, notice } = await f.escalate(permission, "Deleting build output");
  assert.equal(notice.kind, "action-approval");
  assert.equal(notice.source.escalation, true);
  assert.equal(notice.source.actionId, actionId);
  assert.deepEqual(
    notice.actions.map(({ proposalId, decision, answer, label }) => ({
      proposalId,
      decision,
      answer,
      label,
    })),
    [
      {
        proposalId: actionId,
        decision: "answer",
        answer: { choice: "allow" },
        label: "Allow",
      },
      {
        proposalId: actionId,
        decision: "answer",
        answer: { choice: "deny" },
        label: "Deny",
      },
    ],
  );
  assert.ok(
    notice.text.includes(de.escalationTelegram("Home", "`Claude Code · project`")),
  );
  assert.ok(notice.text.includes("Clean the build"));
  assert.ok(notice.text.includes("rm -rf build"));
  assert.ok(notice.text.includes(de.escalationNote));
  assert.ok(notice.text.includes("Deleting build output"));
  // Never a secret of the prompt.
  assert.equal(notice.text.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  assert.ok(notice.link === null || notice.link.url.includes("/chats/"));
  const sent = f.calls.find((c) => c.method === "sendMessage").input;
  assert.deepEqual(
    sent.reply_markup.inline_keyboard[0].map((b) => b.text),
    ["Allow", "Deny"],
  );
  // Another user's press answers nothing.
  await f.service.teamActions.receive(
    f.channel.id,
    f.press(notice.actions[0].handle, 43),
  );
  assert.deepEqual(f.services.requests.answers, []);
  await f.service.teamActions.receive(f.channel.id, f.press(notice.actions[0].handle));
  assert.deepEqual(f.services.requests.answers, [
    {
      sessionId: f.sessionId,
      id: "p1",
      input: { expectedRevision: 1, choice: "allow" },
      handoff: false,
      actor: { kind: "telegram" },
    },
  ]);
  assert.equal(f.callbackTexts().at(-1), de.escalationAnsweredBy.telegram);
  // The broker's event names Telegram; the result goes back to the chat.
  f.workflows.sessions.requestEvent({
    action: "request.answered",
    resourceId: "p1",
    sessionId: f.sessionId,
    outcome: "success",
    details: { actor: "telegram" },
  });
  await f.workflows.tick();
  const result = f.service.outbox
    .all(f.channel.id)
    .find((e) => e.key === `action-result:${actionId}`);
  assert.equal(result.source.escalation, true);
  assert.ok(result.text.startsWith(de.escalationAnsweredBy.telegram));
  assert.deepEqual(result.actions, []);
});

test("a button pressed after the owner answered is stale and delivers nothing", async (t) => {
  const f = await setup(t);
  const { notice } = await f.escalate(permission);
  await f.services.requests.answer(f.sessionId, "p1", {
    expectedRevision: 1,
    choice: "deny",
  });
  await f.service.teamActions.receive(f.channel.id, f.press(notice.actions[0].handle));
  assert.equal(f.services.requests.answers.length, 1);
  assert.equal(f.services.requests.answers[0].actor, null);
  assert.equal(f.callbackTexts().at(-1), de.escalationStale);
});

test("the escalation answers only its own Telegram chat", async (t) => {
  const f = await setup(t);
  const { actionId } = await f.escalate(permission);
  const sessions = f.workflows.sessions;
  const target = f.workflows.store.get(actionId).telegram;
  await assert.rejects(
    sessions.answerEscalation(actionId, { choice: "allow" }, { ...target, chatId: "7" }),
    (error) => error.status === 403,
  );
  await assert.rejects(
    sessions.answerEscalation("missing", { choice: "allow" }, target),
    (error) => error.status === 404,
  );
  assert.deepEqual(f.services.requests.answers, []);
  assert.deepEqual(
    await sessions.answerEscalation(actionId, { choice: "deny" }, target),
    {
      state: "awaiting_approval",
    },
  );
  assert.equal(f.services.requests.answers[0].input.choice, "deny");
});

test("a reply to the escalation answers a free-text question and never reaches the model", async (t) => {
  const f = await setup(t);
  const { notice } = await f.escalate(question("q"));
  // A single single-choice question: one button per option, and replies are taken.
  assert.deepEqual(
    notice.actions.map((a) => a.answer),
    [{ answers: { q1: ["pg"] } }, { answers: { q1: ["sqlite"] } }],
  );
  assert.ok(notice.text.includes("Which database should I use?"));
  assert.ok(notice.text.includes(de.escalationReplyHint));
  const [messageId] = notice.remoteMessageIds.length
    ? notice.remoteMessageIds
    : f.service.outbox.get(notice.id).remoteMessageIds;
  assert.ok(Number.isSafeInteger(messageId));
  // From another user or chat: ignored as today, nothing answered.
  await f.service.ingress.receive(f.channel.id, [f.reply(messageId, "MySQL", 43, 43)]);
  await f.service.ingress.receive(f.channel.id, [f.reply(messageId, "MySQL", 42, 77)]);
  assert.deepEqual(f.services.requests.answers, []);
  assert.deepEqual(f.accepted, []);
  await f.service.ingress.receive(f.channel.id, [f.reply(messageId, "  MariaDB  ")]);
  assert.deepEqual(f.services.requests.answers, [
    {
      sessionId: f.sessionId,
      id: "q",
      input: { expectedRevision: 1, answers: { q1: ["MariaDB"] } },
      handoff: false,
      actor: { kind: "telegram" },
    },
  ]);
  assert.deepEqual(f.accepted, []);
  // A second reply is stale: consumed, answered with a notice, never the model.
  await f.service.ingress.receive(f.channel.id, [f.reply(messageId, "Oracle")]);
  assert.equal(f.services.requests.answers.length, 1);
  assert.deepEqual(f.accepted, []);
  assert.ok(
    f.service.outbox
      .all(f.channel.id)
      .some((e) => e.kind === "escalation-reply" && e.text === de.escalationStale),
  );
  // A plain message that replies to nothing still goes to the model.
  await f.service.ingress.receive(f.channel.id, [
    {
      ...f.reply(1, "Hello"),
      message: { ...f.reply(1, "Hello").message, reply_to_message: undefined },
    },
  ]);
  assert.equal(f.accepted.length, 1);
});

test("a multi-question prompt gets no buttons and the AgentPier link", async (t) => {
  const f = await setup(t);
  const entry = question("multi");
  entry.questions.push({ ...entry.questions[0], id: "q2", prompt: "And the cache?" });
  const { notice } = await f.escalate(entry);
  assert.deepEqual(notice.actions, []);
  assert.ok(notice.text.includes(de.escalationAnswerInApp));
  assert.equal(notice.text.includes(de.escalationReplyHint), false);
  const sent = f.calls.find((c) => c.method === "sendMessage").input;
  assert.equal(sent.reply_markup, undefined);
  // A reply to it is consumed and pointed to AgentPier.
  const [messageId] = f.service.outbox.get(notice.id).remoteMessageIds;
  await f.service.ingress.receive(f.channel.id, [f.reply(messageId, "Redis")]);
  assert.deepEqual(f.services.requests.answers, []);
  assert.deepEqual(f.accepted, []);
  assert.ok(
    f.service.outbox
      .all(f.channel.id)
      .some((e) => e.kind === "escalation-reply" && e.text === de.escalationAnswerInApp),
  );
});

test("a long prompt is cut by code point", async (t) => {
  const f = await setup(t);
  const { notice } = await f.escalate({
    ...permission,
    subject: { tool: "Bash", command: "😀".repeat(2000) },
  });
  // The fenced prompt: exactly 1500 code points ("Bash", a blank line, the
  // command), then the ellipsis; no surrogate pair is split.
  const asked = notice.text.split("```\n")[1].split("\n```")[0];
  assert.ok(asked.endsWith("…"));
  const points = Array.from(asked.slice(0, -1));
  assert.equal(points.length, 1500);
  assert.equal(points.slice(6).join(""), "😀".repeat(1494));
});

test("secrets in the agent's note and the session name never reach Telegram", async (t) => {
  const f = await setup(t);
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const { notice } = await f.escalate(
    permission,
    `Needs TOKEN=${secret} and Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456`,
  );
  assert.ok(notice.text.includes(de.escalationNote));
  assert.ok(notice.text.includes("TOKEN="));
  assert.equal(notice.text.includes(secret), false);
  assert.equal(notice.text.includes("abcdefghijklmnopqrstuvwxyz123456"), false);
  const sent = f.calls.find((c) => c.method === "sendMessage").input.text;
  assert.equal(sent.includes(secret), false);
});
