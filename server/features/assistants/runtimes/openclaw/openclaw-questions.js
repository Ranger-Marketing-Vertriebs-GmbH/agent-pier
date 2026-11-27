// OpenClaw's `ask_user` tool (2026.11.6, docs/tools/ask-user.md) pauses a turn for
// one to three structured questions. The Gateway keeps each request as a question
// record `{ id, questions: [{ questionId, header, question, options: [{ label,
// description, value }], multiSelect, isOther }], agentId, sessionKey, runId,
// createdAtMs, expiresAtMs, status }` and broadcasts it to operator clients as
// `question.requested`; `question.resolved { id, status, answers }` follows an answer
// ("answered"), the tool's timeout ("expired": 900 seconds unless the model names 30
// to 3600) and a withdrawal ("cancelled": the run was aborted, or the question was
// declined). `question.list` returns the pending records, `question.resolve { id,
// answers: { answers: { <questionId>: [value, …] } } }` answers one and `{ id,
// cancel: true }` declines it; all need the scope `operator.questions`, which
// `operator.admin` includes. The Gateway offers the tool to a session whose surface
// takes question input (a session without a channel, as AgentPier's chats, counts
// as web chat) unless the client that sent the turn declared the cap
// `no-question-input` (gateway-protocol.js never does). Records live in the Gateway's
// memory: a Gateway restart ends their runs and drops them.
//
// The port's shape (agent-runtime.js): the run event `question.requested` with the
// payload `{ id, request: { questions: [{ id, header, text, options: [{ label,
// description, value }], multiSelect, other }], agentId, sessionKey, runId },
// createdAtMs, expiresAtMs, sessionKey, runId }` and `question.resolved` with `{ id, status,
// sessionKey, runId }` (OpenClaw names neither session nor run there: both null).
//
// A request AgentPier cannot show has `request.unsupported: true` and no questions:
// one that asks for a secret (`isSecret`, `secretStore`: a credential never goes
// through a chat) or for a form or file (`presentation`, `resource`).

const isRecord = (value) => typeof value === "object" && value !== null;
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

function optionOf(option) {
  const label = text(option?.label, 500).trim();
  if (!label) return null;
  const description = text(option.description, 1000).trim();
  return {
    label,
    ...(description && { description }),
    // The answer OpenClaw expects for the option when it is not its label.
    ...(typeof option.value === "string" &&
      option.value && { value: option.value.slice(0, 4096) }),
  };
}

function questionOf(question) {
  if (!isRecord(question)) return null;
  if (
    question.isSecret ||
    question.secretStore ||
    question.resource ||
    question.presentation
  )
    return null;
  const id = text(question.questionId, 200);
  const asked = text(question.question, 4000);
  if (!id || !asked.trim()) return null;
  const options = (Array.isArray(question.options) ? question.options : [])
    .slice(0, 64)
    .map(optionOf)
    .filter(Boolean);
  return {
    id,
    header: text(question.header, 100),
    text: asked,
    options,
    multiSelect: question.multiSelect === true && options.length > 0,
    // OpenClaw takes any text for a question without options.
    other: question.isOther === true || options.length === 0,
  };
}

/** A question record of OpenClaw as the port's `question.requested` payload, or null. */
export function openClawQuestion(record) {
  const id = text(record?.id, 200);
  if (!id || !Array.isArray(record.questions)) return null;
  const questions = record.questions.slice(0, 3).map(questionOf);
  const shown = questions.length > 0 && questions.every(Boolean);
  const sessionKey = typeof record.sessionKey === "string" ? record.sessionKey : null;
  const runId = typeof record.runId === "string" ? record.runId : null;
  return {
    id,
    request: {
      questions: shown ? questions : [],
      ...(!shown && { unsupported: true }),
      agentId: typeof record.agentId === "string" ? record.agentId : null,
      sessionKey,
      runId,
    },
    createdAtMs: record.createdAtMs,
    expiresAtMs: record.expiresAtMs,
    sessionKey,
    runId,
  };
}

/** OpenClaw's `question.resolved` payload as the port's. */
export function openClawQuestionEnd(payload) {
  return {
    id: text(payload?.id, 200),
    status: ["answered", "expired"].includes(payload?.status)
      ? payload.status
      : "cancelled",
    sessionKey: null,
    runId: null,
  };
}

// The Gateway's reasons for a question it no longer waits on (question-manager).
const ended = new Set(["QUESTION_ALREADY_TERMINAL", "QUESTION_NOT_FOUND"]);

// A refusal as the port reports it: `answered` only for a question that is gone,
// `invalid` for an answer the question does not take; anything else failed to reach
// a decision and may be sent again.
function refusal(error) {
  if (!error?.answered || ended.has(error.detailReason)) return error;
  return Object.assign(new Error(error.message), {
    code: error.code,
    status: 503,
    invalid: error.detailReason === "QUESTION_INVALID_ANSWER",
  });
}

/**
 * The question methods of the approvals sub-port (agent-runtime.js) over `call`, the
 * current client's RPC: the waiting questions, the owner's answer and declining one
 * nobody can answer.
 */
export function openClawQuestions(call) {
  const resolve = (params) =>
    call("question.resolve", { ...params, resolvedBy: "agentpier" }).then(
      () => ({ ok: true, id: params.id }),
      (error) => {
        throw refusal(error);
      },
    );
  return {
    questions: async () => {
      const listed = await call("question.list", {});
      return (Array.isArray(listed?.questions) ? listed.questions : [])
        .filter((record) => record?.status === "pending")
        .map(openClawQuestion)
        .filter(Boolean);
    },
    answer: ({ id, answers }) => resolve({ id, answers: { answers } }),
    decline: ({ id }) => resolve({ id, cancel: true }),
  };
}
