import { refused } from "./hermes-approval-queue.js";

// Hermes's clarify tool asks the person in the chat a question and waits for the
// answer (tools/clarify_gateway.py). The gateway sends every connection attached to
// the session `clarify.request { kind: "clarify", prompt_id, execution_generation,
// question, choices, multi_select, timeout_s }` and takes the answer with
// `clarify.respond { session_id, execution_generation, prompt_id, answer }`, a text
// of at most 16384 characters passed to the tool as it is: a choice's label or free
// text (gateway/session_pending_controls.py). `clarify.settled { prompt_id }` follows
// every answer and also ends a question another viewer answered or Hermes stopped
// waiting for (its `agent.clarify_timeout`, an hour by default; the agent then reads
// that nobody answered); `approval.cancelled { request_ids }` withdraws those an
// interrupt dropped. A session attached again lists what still waits (`prompts` of
// its snapshot), which reopened() asks anew.
//
// The queue publishes each as a run event of kind "other" (agent-runtime.js), event
// `question.requested` with the payload `{ id, request: { question, choices,
// multiSelect, agentId, sessionKey, runId }, createdAtMs, expiresAtMs }` and
// `question.resolved` with `{ id, status, sessionKey, runId }` (`status` "answered",
// "expired" or "cancelled"), which agent-questions.js turns into the question the
// owner sees in the agent's chat. While one waits, its run reports the lifecycle
// phase `waiting-approval` (the run waits for the owner, as for an approval).
//
// Hermes's other questions to a client need what AgentPier never hands out through a
// prompt: a sudo password (`sudo`) or a secret's value (`secret`; agents receive
// secrets the owner granted them in AgentPier). Both are declined at once with
// Hermes's own "declined" answer, an empty value, so the agent goes on and says it
// lacks them instead of waiting out Hermes's deadline.

const defaultTimeoutS = 3600;
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
export const maxAnswerLength = 16384;
export const declinedRequests = ["sudo", "secret"];

export class HermesQuestionQueue {
  constructor(client, runs) {
    Object.assign(this, { client, runs });
    this.pending = new Map();
    for (const method of declinedRequests) client.handle(method, () => ({ value: "" }));
    client.subscribe((params) => this.observe(params || {}));
    client.once("disconnected", () => this.pending.clear());
  }

  observe({ type, session_id: sid, payload, admission_id: admission }) {
    if (
      type === "clarify.request" ||
      (type === "approval.request" && payload?.kind === "clarify")
    )
      this.asked(sid, payload, admission);
    else if (type === "clarify.settled") this.settled(payload);
    else if (type === "approval.cancelled") this.cancelled(payload);
  }

  /** The clarify questions a snapshot of session `sid` lists as still waiting. */
  reopened(sid, prompts) {
    for (const prompt of Array.isArray(prompts) ? prompts : [])
      if (prompt?.kind === "clarify") this.asked(sid, prompt, null);
  }

  asked(sessionId, params, admission) {
    const id = text(params?.prompt_id, 200);
    if (!id || this.pending.has(id)) return;
    const sid = text(sessionId, 200);
    const sessionKey = this.runs.keyOf(sid);
    const runId = this.runs.runOfAdmission(sid, admission) ?? this.runs.runOf(sid);
    const createdAtMs = Date.now();
    const timeoutS =
      Number.isFinite(params.timeout_s) && params.timeout_s > 0
        ? params.timeout_s
        : defaultTimeoutS;
    const generation = Number.isSafeInteger(params.execution_generation)
      ? params.execution_generation
      : this.runs.fences(sid).generation;
    const choices = Array.isArray(params.choices)
      ? params.choices.slice(0, 20).map((choice) => text(choice, 500))
      : [];
    const item = {
      id,
      request: {
        question: text(params.question, 4000),
        choices,
        multiSelect: params.multi_select === true && choices.length > 0,
        agentId: this.runs.agentId,
        sessionKey,
        runId,
        hermes: { sessionId: sid, promptId: id, executionGeneration: generation },
      },
      createdAtMs,
      expiresAtMs: createdAtMs + timeoutS * 1000,
    };
    this.pending.set(id, item);
    this.publish("question.requested", item, { ...structuredClone(item), sessionKey });
    this.phase(item, "waiting-approval", "clarify.request");
  }

  /** The questions that wait for an answer. */
  list() {
    return [...this.pending.values()].map((item) => structuredClone(item));
  }

  /** Sends `answer` (a choice's label or free text) to question `id`. */
  async answer({ id, answer }) {
    const item = this.pending.get(id);
    if (!item) throw refused("unknown or expired question id");
    if (typeof answer !== "string" || !answer.trim() || answer.length > maxAnswerLength)
      throw refused("answer must be a non-empty text");
    const { sessionId, executionGeneration } = item.request.hermes;
    item.answering = true;
    let result;
    try {
      result = await this.client.call("clarify.respond", {
        session_id: sessionId,
        execution_generation: executionGeneration,
        prompt_id: id,
        answer,
      });
    } finally {
      item.answering = false;
    }
    if (!this.pending.has(id)) return { ok: true, id };
    this.pending.delete(id);
    if (result?.status !== "resolved") {
      this.end(item, "cancelled");
      throw refused("unknown or expired question id");
    }
    this.end(item, "answered");
    return { ok: true, id };
  }

  settled(payload) {
    const item = this.pending.get(text(payload?.prompt_id, 200));
    if (!item || item.answering) return;
    this.pending.delete(item.id);
    this.end(item, Date.now() >= item.expiresAtMs ? "expired" : "cancelled");
  }

  cancelled(payload) {
    for (const id of Array.isArray(payload?.request_ids) ? payload.request_ids : []) {
      const item = this.pending.get(text(id, 200));
      if (!item) continue;
      this.pending.delete(item.id);
      this.end(item, "cancelled");
    }
  }

  end(item, status) {
    const { sessionKey, runId } = item.request;
    this.publish("question.resolved", item, { id: item.id, status, sessionKey, runId });
    this.phase(item, "approval-resolved", "clarify.settled");
  }

  publish(event, item, payload) {
    const { sessionKey, runId } = item.request;
    this.runs.emit({
      kind: "other",
      sessionKey,
      runId,
      reason: null,
      reply: null,
      step: null,
      event,
      payload,
    });
  }

  phase(item, phase, event) {
    const { sessionKey, runId } = item.request;
    if (!sessionKey || !runId || this.runs.outcomes.has(runId)) return;
    this.runs.emit({
      kind: "progress",
      sessionKey,
      runId,
      reason: null,
      reply: null,
      step: { type: "lifecycle", phase },
      event,
      payload: { id: item.id, sessionKey, runId },
    });
  }
}
