import { assistantProblem } from "./assistant-validation.js";
import { followUpTelegram } from "./follow-up-target.js";
import { runtimeForSession } from "./runtimes/runtime-for.js";
import { telegramMessages } from "../assistant-channels/telegram-messages.js";

// Questions an agent asks the person in its chat while its turn waits (Hermes's
// clarify tool, runtimes/hermes/hermes-questions.js), as the run events
// "question.requested" and "question.resolved" of the agent's runtime. Each one
// shows in the chat it belongs to (the chat feed's `questions`, the chat's question
// card) and, when the turn came from the owner's paired Telegram chat
// (follow-up-target.js, the rule exec approvals follow), as a notice there; the
// owner's next message in that chat is the answer (telegram-ingress.js). The answer
// goes back to the runtime (approvals.answer), the turn goes on. Hermes ends a
// question nobody answered after its timeout, an hour by default: the agent then
// reads that nobody answered. A question lives as long as its turn waits, so none is
// stored: after a restart of AgentPier or the agent, Hermes asks again.

const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");
// The answer Hermes gets: a choice's label for its number ("2"), else the text.
function chosen(question, answer) {
  const typed = typeof answer === "string" ? answer.trim() : "";
  const number = /^\d{1,2}$/.test(typed) ? Number(typed) : 0;
  return number >= 1 && number <= question.choices.length
    ? question.choices[number - 1]
    : typed;
}

export class AgentQuestions {
  constructor(service, { now = Date.now } = {}) {
    Object.assign(this, { s: service, now });
    this.pending = new Map();
    const hub = service.gatewayEvents;
    hub?.on("question.requested", (payload) => this.requested(payload));
    hub?.on("question.resolved", (payload) => this.resolved(payload));
  }

  requested(payload) {
    const id = text(payload?.id, 200);
    const request = payload?.request;
    if (!id || !request || typeof request.sessionKey !== "string") return;
    const conversation = this.s.store
      .listConversations()
      .find((c) => c.runtimeSessionKey === request.sessionKey && !c.archivedAt);
    // A question of no chat AgentPier knows waits for Hermes's own timeout.
    if (!conversation) return;
    const assistant = this.s.store.getAssistant(conversation.assistantId);
    if (assistant.runtimeAgentId !== request.agentId) return;
    const question = {
      id,
      conversationId: conversation.id,
      assistantId: assistant.id,
      sessionKey: request.sessionKey,
      runId: request.runId ?? null,
      question: text(request.question, 4000),
      choices: Array.isArray(request.choices)
        ? request.choices.filter((c) => typeof c === "string" && c.trim())
        : [],
      multiSelect: request.multiSelect === true,
      createdAt: Number.isSafeInteger(payload.createdAtMs)
        ? payload.createdAtMs
        : this.now(),
      expiresAt: Number.isSafeInteger(payload.expiresAtMs) ? payload.expiresAtMs : null,
      telegram: followUpTelegram(this.s, this.s.channels, assistant, conversation),
    };
    this.pending.set(id, question);
    if (question.telegram) this.notify(assistant, question);
    this.s.changed?.({ conversationId: conversation.id });
  }

  // The question as a Telegram notice in the channel's language: the agent's name,
  // the question, its numbered choices and how to answer.
  notify(assistant, question) {
    try {
      const channels = this.s.channels;
      const channel = channels.store.get(question.telegram.channelId);
      const copy = telegramMessages(channel);
      const lines = [
        copy.telegramQuestion(assistant.name, question.question),
        ...question.choices.map((choice, i) => `${i + 1}. ${choice}`),
        "",
        question.choices.length
          ? copy.telegramQuestionChoices
          : copy.telegramQuestionAnswer,
      ];
      channels.outbox.enqueue({
        key: `question:${question.id}`,
        source: question.telegram,
        kind: "question",
        text: lines.join("\n"),
      });
    } catch {
      // The question still waits in the chat; Telegram is an extra.
    }
  }

  resolved(payload) {
    const question = this.pending.get(text(payload?.id, 200));
    if (!question) return;
    this.pending.delete(question.id);
    this.s.changed?.({ conversationId: question.conversationId });
  }

  /** The questions waiting in chat `conversationId`, oldest first. */
  list(conversationId) {
    const now = this.now();
    return [...this.pending.values()]
      .filter((q) => q.conversationId === conversationId && !(q.expiresAt <= now))
      .map(({ telegram: _telegram, sessionKey: _key, ...shown }) => shown);
  }

  /**
   * The oldest question waiting for an answer from the paired Telegram chat `target`
   * (`{ channelId, chatId, userId }`) in `conversationId`, or null.
   */
  waitingFor(conversationId, target) {
    return (
      this.list(conversationId).find((q) => {
        const asked = this.pending.get(q.id)?.telegram;
        return (
          asked &&
          ["channelId", "chatId", "userId"].every(
            (k) => String(asked[k]) === String(target?.[k]),
          )
        );
      }) || null
    );
  }

  /**
   * Sends the owner's answer to question `id` of `conversationId`: a choice's label or
   * free text. Refuses an unknown question (404), an empty or overlong answer (400)
   * and one the runtime no longer waits for (409, it is gone then).
   */
  async answer(conversationId, id, input) {
    const question = this.pending.get(id);
    if (!question || question.conversationId !== conversationId)
      throw assistantProblem("notFound", 404);
    const answer = chosen(question, input?.answer);
    if (!answer || answer.length > 16384) throw assistantProblem("invalid");
    const runtime = runtimeForSession(question.sessionKey, this.s.runtime);
    try {
      await runtime.approvals.answer({ id, answer });
    } catch (error) {
      if (!error?.answered) throw assistantProblem("unavailable", 503);
      this.pending.delete(id);
      this.s.changed?.({ conversationId });
      throw assistantProblem("questionGone", 409);
    }
    this.pending.delete(id);
    this.s.changed?.({ conversationId });
    return { ok: true, id };
  }
}
