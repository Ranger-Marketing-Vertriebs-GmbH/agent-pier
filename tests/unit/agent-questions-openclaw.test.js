import test from "node:test";
import assert from "node:assert/strict";
import { AgentQuestions } from "../../server/features/assistants/agent-questions.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { openClawRunEvent } from "../../server/features/assistants/runtimes/openclaw/openclaw-events.js";
import { TelegramIngress } from "../../server/features/assistant-channels/telegram-ingress.js";

// The questions of an OpenClaw agent's ask_user tool in AgentQuestions: one to three
// per request, answered in one piece through OpenClaw's question.resolve, behind the
// real OpenClaw adapter on a scripted Gateway client.
const key = "agent:ap-1:dashboard:s1";
const target = { channelId: "ch1", chatId: "42", userId: "42" };
const stage = {
  questionId: "stage",
  header: "Stage",
  question: "Which stage?",
  options: [
    { label: "Staging (Recommended)", description: "The test system" },
    { label: "Production", value: "prod" },
  ],
  isOther: true,
};
const regions = {
  questionId: "regions",
  header: "Regions",
  question: "Which regions?",
  options: [{ label: "EU" }, { label: "US" }, { label: "Asia" }],
  multiSelect: true,
};
const note = {
  questionId: "note",
  header: "Note",
  question: "Anything else?",
  options: [],
};
const record = (id, questions, extra = {}) => ({
  id,
  questions,
  agentId: "ap-1",
  sessionKey: key,
  runId: "run-1",
  createdAtMs: Date.now(),
  expiresAtMs: Date.now() + 60000,
  status: "pending",
  ...extra,
});

function service({ telegram = false } = {}) {
  const conversation = { id: "c1", assistantId: "a1", runtimeSessionKey: key };
  const assistant = { id: "a1", name: "Helper", runtimeAgentId: "ap-1" };
  const calls = [];
  const gateway = { listed: [], failure: null };
  // The supervisor of the shared host: its client is all the approvals sub-port uses.
  const runtime = {
    client: {
      call: async (method, params) => {
        calls.push([method, params]);
        if (gateway.failure) throw gateway.failure;
        return method === "question.list" ? { questions: gateway.listed } : {};
      },
    },
  };
  const notices = [];
  const changes = [];
  const s = {
    runtime,
    gatewayEvents: new GatewayEventHub(),
    store: {
      listConversations: () => [conversation],
      getConversation: () => conversation,
      getAssistant: () => assistant,
    },
    ledger: { latestRequest: () => ({ id: "r1" }) },
    teams: {
      store: { context: () => (telegram ? { kind: "telegram", ...target } : null) },
    },
    changed: (change) => changes.push(change),
  };
  s.channels = {
    assistants: s,
    store: {
      list: () => [
        {
          id: "ch1",
          assistantId: "a1",
          conversationId: "c1",
          enabled: true,
          chatId: "42",
          userId: "42",
        },
      ],
      get: () => ({ id: "ch1", language: "en" }),
    },
    outbox: { enqueue: (entry) => notices.push(entry) },
  };
  const frame = (event, payload) =>
    s.gatewayEvents.deliver(openClawRunEvent({ event, payload }));
  const resolves = () => calls.filter(([method]) => method === "question.resolve");
  return { s, calls, gateway, notices, changes, frame, resolves };
}
const refused = (detailReason) =>
  Object.assign(new Error("refused"), {
    code: "INVALID_REQUEST",
    answered: true,
    detailReason,
  });

test("a request of three questions is answered in one piece", async () => {
  const { s, frame, resolves } = service();
  const questions = new AgentQuestions(s);
  frame("question.requested", record("q1", [stage, regions, note]));
  const [shown] = questions.list("c1");
  assert.deepEqual(
    shown.questions.map((q) => [q.id, q.header, q.multiSelect, q.other]),
    [
      ["stage", "Stage", false, true],
      ["regions", "Regions", true, false],
      ["note", "Note", false, true],
    ],
  );
  // The chat shows labels and descriptions, never an option's own answer value.
  assert.deepEqual(shown.questions[0].options, [
    { label: "Staging (Recommended)", description: "The test system" },
    { label: "Production" },
  ]);
  const invalid = { key: "invalid", status: 400 };
  const answer = (answers) => questions.answer("c1", "q1", { answers });
  // Every question needs its answer.
  await assert.rejects(answer({ stage: ["Production"] }), invalid);
  await assert.rejects(
    answer({ stage: ["Production"], regions: [], note: ["x"] }),
    invalid,
  );
  // One value for a single choice, a listed option where no own answer is taken,
  // and no answer for a question the request does not ask.
  const rest = { regions: ["EU"], note: ["none"] };
  await assert.rejects(answer({ ...rest, stage: ["Production", "x"] }), invalid);
  await assert.rejects(
    answer({ ...rest, stage: ["Production"], regions: ["Mars"] }),
    invalid,
  );
  await assert.rejects(answer({ ...rest, stage: ["Production"], other: ["x"] }), invalid);
  // A typed answer alone cannot answer three questions.
  await assert.rejects(questions.answer("c1", "q1", { answer: "1" }), invalid);
  assert.deepEqual(resolves(), []);
  await answer({
    stage: ["Production"],
    regions: ["EU", "Asia", "EU"],
    note: [" none "],
  });
  assert.deepEqual(resolves(), [
    [
      "question.resolve",
      {
        id: "q1",
        // An option goes back as the value OpenClaw expects for it.
        answers: {
          answers: { stage: ["prod"], regions: ["EU", "Asia"], note: ["none"] },
        },
        resolvedBy: "agentpier",
      },
    ],
  ]);
  assert.deepEqual(questions.list("c1"), []);
});

test("an answer OpenClaw refuses keeps the question; one it no longer waits for is gone", async () => {
  const { s, gateway, frame } = service();
  const questions = new AgentQuestions(s);
  frame("question.requested", record("q1", [stage]));
  const answer = () =>
    questions.answer("c1", "q1", { answers: { stage: ["Production"] } });
  gateway.failure = refused("QUESTION_INVALID_ANSWER");
  await assert.rejects(answer(), { key: "invalid", status: 400 });
  gateway.failure = Object.assign(new Error("closed"), { code: "UNAVAILABLE" });
  await assert.rejects(answer(), { status: 503 });
  assert.equal(questions.list("c1").length, 1);
  gateway.failure = refused("QUESTION_ALREADY_TERMINAL");
  await assert.rejects(answer(), { key: "questionGone", status: 409 });
  assert.deepEqual(questions.list("c1"), []);
});

test("a timeout and an aborted turn end the question", () => {
  const { s, frame, changes } = service();
  const questions = new AgentQuestions(s);
  for (const status of ["expired", "cancelled"]) {
    frame("question.requested", record(status, [stage]));
    assert.equal(questions.list("c1").length, 1);
    frame("question.resolved", { id: status, status });
    assert.deepEqual(questions.list("c1"), []);
    assert.deepEqual(changes.at(-1), { conversationId: "c1" });
  }
  // One whose end was missed leaves the chat at its expiry.
  frame("question.requested", record("late", [stage], { expiresAtMs: Date.now() - 1 }));
  assert.deepEqual(questions.list("c1"), []);
});

test("a question nobody can answer is declined at once", async () => {
  const { s, frame, resolves } = service();
  const questions = new AgentQuestions(s);
  // A session that is no chat of AgentPier, another agent's session key, and a
  // request AgentPier does not show (a secret).
  frame("question.requested", record("q1", [stage], { sessionKey: "agent:ap-1:main" }));
  frame("question.requested", record("q2", [stage], { agentId: "ap-2" }));
  frame("question.requested", record("q3", [{ ...stage, isSecret: true }]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(questions.list("c1"), []);
  assert.deepEqual(
    resolves().map(([, params]) => params),
    ["q1", "q2", "q3"].map((id) => ({ id, cancel: true, resolvedBy: "agentpier" })),
  );
});

test("a reconnect takes up what still waits and drops what ended meanwhile", async () => {
  const { s, gateway, frame, calls } = service();
  const questions = new AgentQuestions(s);
  frame("question.requested", record("old", [stage]));
  frame("question.requested", record("kept", [stage]));
  frame("question.requested", record("done", [stage]));
  frame("question.resolved", { id: "done", status: "answered" });
  // While the connection was away "old" ended and "new" was asked; the listing
  // was read before "done" ended.
  gateway.listed = [
    record("kept", [stage]),
    record("new", [regions]),
    record("done", [stage]),
  ];
  s.gatewayEvents.ready();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), ["question.list", {}]);
  assert.deepEqual(
    questions.list("c1").map((q) => q.id),
    ["kept", "new"],
  );
  // A listing that fails leaves the chat as it was.
  gateway.failure = Object.assign(new Error("closed"), { code: "UNAVAILABLE" });
  await assert.rejects(questions.resync());
  assert.equal(questions.list("c1").length, 2);
});

test("the paired Telegram chat answers a request one question after another", async () => {
  const { s, gateway, notices, resolves } = service({ telegram: true });
  s.questions = new AgentQuestions(s);
  s.gatewayEvents.deliver(
    openClawRunEvent({
      event: "question.requested",
      payload: record("q1", [stage, regions, note]),
    }),
  );
  assert.deepEqual(
    notices.map((n) => [n.key, n.text]),
    [
      [
        "question:q1",
        "Helper asks (1 of 3): Which stage?\n1. Staging (Recommended) – The test system\n2. Production\n\nReply with a number or with your own answer.",
      ],
    ],
  );
  const patched = [];
  const sent = [];
  const ingress = new TelegramIngress({
    assistants: s,
    ledger: { patch: (id, patch) => patched.push([id, patch]) },
    notice: (_channel, notice) => sent.push(notice),
  });
  const channel = { id: "ch1", conversationId: "c1", language: "en" };
  const say = (id, text) =>
    ingress.answerQuestion(channel, { id, text, chatId: "42", userId: "42" });
  assert.equal(await say("e1", "2"), true);
  assert.deepEqual(
    [notices[1].key, notices[1].text],
    [
      "question:q1:1",
      "Helper asks (2 of 3): Which regions?\n1. EU\n2. US\n3. Asia\n\nReply with one or more numbers, separated by commas, or with your own answer.",
    ],
  );
  // A listing after a reconnect names the request again: it keeps the answer given
  // so far and is not announced twice.
  gateway.listed = [record("q1", [stage, regions, note])];
  await s.questions.resync();
  assert.equal(notices.length, 2);
  // No own answer is taken here: the message goes out as a turn, the question stays.
  assert.equal(await say("e2", "Mars"), false);
  assert.equal(await say("e3", "1, 3"), true);
  assert.equal(
    notices[2].text,
    "Helper asks (3 of 3): Anything else?\n\nSend your answer as a message.",
  );
  assert.deepEqual(resolves(), []);
  assert.deepEqual(sent, []);
  // The Gateway is away: the last message waits and is taken again.
  gateway.failure = Object.assign(new Error("closed"), { code: "UNAVAILABLE" });
  assert.equal(await say("e4", "ship it"), true);
  gateway.failure = null;
  assert.equal(await say("e4", "ship it"), true);
  assert.deepEqual(resolves().at(-1)[1].answers, {
    answers: { stage: ["prod"], regions: ["EU", "Asia"], note: ["ship it"] },
  });
  assert.deepEqual(
    patched.map(([id]) => id),
    ["e1", "e3", "e4"],
  );
  assert.deepEqual(
    sent.map((n) => n.text),
    ["Answer sent to the agent."],
  );
  assert.equal(notices.length, 3);
  assert.equal(await say("e5", "x"), false);
});
