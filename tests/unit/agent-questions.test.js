import test from "node:test";
import assert from "node:assert/strict";
import { AgentQuestions } from "../../server/features/assistants/agent-questions.js";
import { GatewayEventHub } from "../../server/features/assistants/gateway-event-hub.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { TelegramIngress } from "../../server/features/assistant-channels/telegram-ingress.js";

const key = "agent:ap-h:hermes:s1";
const target = { channelId: "ch1", chatId: "42", userId: "42" };

// An assistant service with one Hermes agent and its chat; `telegram` makes the
// chat's latest turn come from the owner's paired Telegram chat.
function service({ telegram = false, answer = async () => ({ ok: true }) } = {}) {
  const conversation = { id: "c1", assistantId: "a1", runtimeSessionKey: key };
  const assistant = {
    id: "a1",
    name: "Helper",
    runtime: "hermes",
    runtimeAgentId: "ap-h",
  };
  const answers = [];
  const runtime = {};
  attachHermesFleet(runtime, {
    available: () => true,
    runtimeOf: () => ({
      approvals: {
        answer: async (input) => {
          answers.push(input);
          return answer(input);
        },
      },
    }),
  });
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
  return { s, answers, notices, changes };
}

const asked = (hub, extra = {}) =>
  hub.deliver({
    kind: "other",
    event: "question.requested",
    payload: {
      id: "q1",
      request: {
        question: "Which stage?",
        choices: ["staging", "prod"],
        multiSelect: false,
        agentId: "ap-h",
        sessionKey: key,
        runId: "run-1",
      },
      createdAtMs: Date.now(),
      expiresAtMs: Date.now() + 60000,
      ...extra,
    },
  });

test("a question waits in its chat and the owner's answer reaches the runtime", async () => {
  const { s, answers, notices, changes } = service();
  const questions = new AgentQuestions(s);
  asked(s.gatewayEvents);
  assert.deepEqual(
    questions.list("c1").map((q) => [q.id, q.question, q.choices, q.runId]),
    [["q1", "Which stage?", ["staging", "prod"], "run-1"]],
  );
  assert.equal(questions.list("c1")[0].telegram, undefined);
  assert.deepEqual(changes.at(-1), { conversationId: "c1" });
  // The web chat's question only: no Telegram notice.
  assert.equal(notices.length, 0);
  await assert.rejects(questions.answer("c2", "q1", { answer: "prod" }), {
    status: 404,
  });
  await assert.rejects(questions.answer("c1", "q1", { answer: "  " }), { status: 400 });
  // A choice's number is its label.
  await questions.answer("c1", "q1", { answer: "2" });
  assert.deepEqual(answers, [{ id: "q1", answer: "prod" }]);
  assert.deepEqual(questions.list("c1"), []);
  // Ended by the runtime (answered elsewhere, timed out).
  asked(s.gatewayEvents, { id: "q2" });
  s.gatewayEvents.deliver({ event: "question.resolved", payload: { id: "q2" } });
  assert.deepEqual(questions.list("c1"), []);
  // A question of a chat AgentPier does not know is not shown.
  asked(s.gatewayEvents, {
    id: "q3",
    request: { question: "?", agentId: "ap-h", sessionKey: "agent:ap-h:hermes:other" },
  });
  assert.deepEqual(questions.list("c1"), []);
});

test("a question the runtime no longer waits for is gone", async () => {
  const { s } = service({
    answer: async () => {
      throw Object.assign(Error("gone"), { answered: true });
    },
  });
  const questions = new AgentQuestions(s);
  asked(s.gatewayEvents);
  await assert.rejects(questions.answer("c1", "q1", { answer: "prod" }), {
    key: "questionGone",
    status: 409,
  });
  assert.deepEqual(questions.list("c1"), []);
});

test("a turn from Telegram asks there too, and the next message there answers it", async () => {
  const { s, answers, notices } = service({ telegram: true });
  s.questions = new AgentQuestions(s);
  asked(s.gatewayEvents);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, "question");
  assert.deepEqual(notices[0].source, target);
  assert.equal(
    notices[0].text,
    "Helper asks: Which stage?\n1. staging\n2. prod\n\nReply with a number or with your own answer.",
  );
  const patched = [];
  const sent = [];
  const ingress = new TelegramIngress({
    assistants: s,
    ledger: { patch: (id, patch) => patched.push([id, patch]) },
    notice: (_channel, notice) => sent.push(notice),
  });
  const channel = { id: "ch1", conversationId: "c1", language: "en" };
  // A forwarded message or a file is never the answer.
  assert.equal(
    await ingress.answerQuestion(channel, {
      id: "e0",
      text: "staging",
      forwarded: true,
      chatId: "42",
      userId: "42",
    }),
    false,
  );
  assert.equal(
    await ingress.answerQuestion(channel, {
      id: "e1",
      text: "staging please",
      chatId: "42",
      userId: "42",
    }),
    true,
  );
  assert.deepEqual(answers, [{ id: "q1", answer: "staging please" }]);
  assert.deepEqual(patched, [["e1", { state: "delivered", diagnostic: null }]]);
  assert.equal(sent[0].text, "Answer sent to the agent.");
  // Nothing waits any more: the next message is a turn again.
  assert.equal(
    await ingress.answerQuestion(channel, {
      id: "e2",
      text: "x",
      chatId: "42",
      userId: "42",
    }),
    false,
  );
});
