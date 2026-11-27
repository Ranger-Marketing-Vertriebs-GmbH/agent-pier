import test from "node:test";
import assert from "node:assert/strict";
import { openClawRunEvent } from "../../server/features/assistants/runtimes/openclaw/openclaw-events.js";
import { openClawQuestions } from "../../server/features/assistants/runtimes/openclaw/openclaw-questions.js";
import { gatewayHandshake } from "../../server/features/assistants/runtimes/openclaw/gateway-protocol.js";

// OpenClaw's question frames as the port's run events (openclaw-questions.js). The
// record is the one OpenClaw 2026.11.6 broadcast for an ask_user call
// (tests/integration/assistant-ask-user-contract.test.js).
const key = "agent:main:dashboard:fc2c5f72-09f6-466f-8d42-f50159c24060";
const record = (questions, extra = {}) => ({
  id: "ask_2d4d38ed553c346a1fb1e91fa6217606",
  questions,
  agentId: "main",
  sessionKey: key,
  runId: "run-1",
  createdAtMs: 1795778248394,
  expiresAtMs: 1795778308394,
  status: "pending",
  ...extra,
});
const stage = {
  questionId: "deploy_target",
  header: "Stage",
  question: "Which stage?",
  options: [
    { label: "Staging (Recommended)", description: "The test system" },
    { label: "Production" },
  ],
  isOther: true,
};
const requested = (questions, extra) =>
  openClawRunEvent({ event: "question.requested", payload: record(questions, extra) });

test("a question record becomes the port's question.requested event", () => {
  const event = requested([
    stage,
    {
      questionId: "regions",
      header: "Regions",
      question: "Which regions?",
      options: [{ label: "EU", value: "eu-1" }, { label: "US" }],
      multiSelect: true,
    },
    { questionId: "note", header: "Note", question: "Anything else?", options: [] },
  ]);
  assert.equal(event.kind, "other");
  assert.equal(event.event, "question.requested");
  assert.equal(event.sessionKey, key);
  assert.equal(event.runId, "run-1");
  assert.deepEqual(event.payload, {
    id: "ask_2d4d38ed553c346a1fb1e91fa6217606",
    request: {
      questions: [
        {
          id: "deploy_target",
          header: "Stage",
          text: "Which stage?",
          options: [
            { label: "Staging (Recommended)", description: "The test system" },
            { label: "Production" },
          ],
          multiSelect: false,
          other: true,
        },
        {
          id: "regions",
          header: "Regions",
          text: "Which regions?",
          // An option's own answer value is kept beside its label.
          options: [{ label: "EU", value: "eu-1" }, { label: "US" }],
          multiSelect: true,
          other: false,
        },
        // Without options OpenClaw takes any text.
        {
          id: "note",
          header: "Note",
          text: "Anything else?",
          options: [],
          multiSelect: false,
          other: true,
        },
      ],
      agentId: "main",
      sessionKey: key,
      runId: "run-1",
    },
    createdAtMs: 1795778248394,
    expiresAtMs: 1795778308394,
    sessionKey: key,
    runId: "run-1",
  });
});

test("a request for a secret, a form or a file is marked as not shown", () => {
  for (const extra of [
    { isSecret: true },
    { secretStore: { name: "API_KEY", kind: "secret" } },
    { presentation: "form" },
    { resource: { selection: "explicit" } },
  ]) {
    const { request } = requested([stage, { ...stage, ...extra }]).payload;
    assert.deepEqual(request.questions, [], JSON.stringify(extra));
    assert.equal(request.unsupported, true);
    assert.equal(request.sessionKey, key);
  }
  // A frame that is no record at all carries no payload.
  assert.equal(
    openClawRunEvent({ event: "question.requested", payload: { id: "x" } }).payload,
    null,
  );
});

test("a question's end names how it ended, never the answers", () => {
  const ended = (payload) =>
    openClawRunEvent({ event: "question.resolved", payload }).payload;
  assert.deepEqual(
    ended({ id: "q1", status: "answered", answers: { answers: { a: ["secret"] } } }),
    { id: "q1", status: "answered", sessionKey: null, runId: null },
  );
  assert.equal(ended({ id: "q1", status: "expired" }).status, "expired");
  assert.equal(ended({ id: "q1", status: "cancelled" }).status, "cancelled");
});

test("the handshake leaves ask_user available and can answer it", () => {
  const { caps, scopes } = gatewayHandshake("t", ["exec-approvals"]);
  // "no-question-input" would take ask_user from every turn of this client.
  assert.equal(caps.includes("no-question-input"), false);
  // operator.admin includes operator.questions (OpenClaw operator-scope-compat).
  assert.ok(scopes.includes("operator.admin"));
});

test("questions are listed, answered and declined through OpenClaw's RPC", async () => {
  const calls = [];
  let failure = null;
  const port = openClawQuestions(async (method, params) => {
    calls.push([method, params]);
    if (failure) throw failure;
    if (method === "question.list")
      return {
        questions: [record([stage]), record([stage], { id: "q2", status: "answered" })],
      };
    return { status: "answered" };
  });
  const listed = await port.questions();
  assert.deepEqual(
    listed.map((item) => [item.id, item.request.questions[0].text]),
    [["ask_2d4d38ed553c346a1fb1e91fa6217606", "Which stage?"]],
  );
  assert.deepEqual(
    await port.answer({ id: "q1", answers: { deploy_target: ["Production"] } }),
    { ok: true, id: "q1" },
  );
  await port.decline({ id: "q1" });
  assert.deepEqual(calls.slice(1), [
    [
      "question.resolve",
      {
        id: "q1",
        answers: { answers: { deploy_target: ["Production"] } },
        resolvedBy: "agentpier",
      },
    ],
    ["question.resolve", { id: "q1", cancel: true, resolvedBy: "agentpier" }],
  ]);
  const refused = (detailReason) =>
    Object.assign(new Error("refused"), {
      code: "INVALID_REQUEST",
      answered: true,
      detailReason,
    });
  const answer = () => port.answer({ id: "q1", answers: { deploy_target: ["x"] } });
  // A question OpenClaw no longer waits on is gone.
  for (const reason of ["QUESTION_ALREADY_TERMINAL", "QUESTION_NOT_FOUND"]) {
    failure = refused(reason);
    await assert.rejects(answer(), (error) => error.answered === true && !error.invalid);
  }
  // An answer the question does not take leaves it waiting.
  failure = refused("QUESTION_INVALID_ANSWER");
  await assert.rejects(answer(), (error) => error.invalid === true && !error.answered);
  // Any other refusal, and a call that never reached OpenClaw, may be sent again.
  failure = Object.assign(new Error("busy"), { code: "UNAVAILABLE", answered: true });
  await assert.rejects(answer(), (error) => !error.answered && !error.invalid);
  failure = Object.assign(new Error("closed"), { code: "UNAVAILABLE" });
  await assert.rejects(answer(), (error) => !error.answered && !error.invalid);
});
