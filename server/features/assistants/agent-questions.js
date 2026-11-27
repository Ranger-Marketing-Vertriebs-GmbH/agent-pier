import { assistantProblem } from "./assistant-validation.js";
import { followUpTelegram } from "./follow-up-target.js";
import {
  ownHostSessionKey,
  runtimeFor,
  runtimeForSession,
} from "./runtimes/runtime-for.js";
import { telegramQuestionMessages } from "../assistant-channels/telegram-messages.js";

// Questions an agent asks the person in its chat while its turn waits (OpenClaw's
// ask_user tool, runtimes/openclaw/openclaw-questions.js; Hermes's clarify tool,
// runtimes/hermes/hermes-questions.js), as the run events "question.requested" and
// "question.resolved" of the agent's runtime. A request holds one to three
// questions, each with its text, a short header, options (label and description),
// whether several options may be chosen and whether an own answer is taken
// (agent-runtime.js approvals). Each request shows in the chat it belongs to (the
// chat feed's `questions`, the chat's question card) and, when the turn came from
// the owner's paired Telegram chat (follow-up-target.js, the rule exec approvals
// follow), as a notice there, one question at a time; the owner's next message in
// that chat answers the question asked last (telegram-ingress.js). The answers go
// back to the runtime in one piece (approvals.answer), the turn goes on. The runtime
// ends a question nobody answered after its timeout (OpenClaw: 15 minutes unless the
// agent names 30 seconds to an hour; Hermes: an hour): the agent then reads that
// nobody answered. A question lives as long as its turn waits, so none is stored.
// After a reconnect the shared host is asked what still waits (resync); Hermes asks
// again after a restart.
//
// A request nobody can answer is declined at once where the runtime takes that
// (approvals.decline, OpenClaw), so the agent goes on instead of waiting out the
// timeout: one from a session that is no chat of AgentPier, and one AgentPier does
// not show (a secret, a form).

const maxAnswerLength = 16384;
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

function optionOf(option) {
  const label = text(option?.label, 500);
  if (!label.trim()) return null;
  const description = text(option.description, 1000);
  return {
    label,
    ...(description && { description }),
    ...(typeof option.value === "string" && option.value && { value: option.value }),
  };
}

function questionOf(question) {
  const id = text(question?.id, 200);
  if (!id) return null;
  const options = (Array.isArray(question.options) ? question.options : [])
    .slice(0, 64)
    .map(optionOf)
    .filter(Boolean);
  return {
    id,
    header: text(question.header, 100),
    text: text(question.text, 4000),
    options,
    multiSelect: question.multiSelect === true && options.length > 0,
    other: question.other === true || options.length === 0,
  };
}

/**
 * What the runtime gets for `question` from the owner's `values` (options' labels or
 * own text), or null when they do not answer it: none, several for a single choice,
 * or an own answer the question does not take. An option's label becomes the value
 * the runtime expects for it.
 */
function answerValues(question, values) {
  if (!Array.isArray(values) || !values.length) return null;
  const answer = [];
  for (const value of values) {
    const typed = typeof value === "string" ? value.trim() : "";
    if (!typed) return null;
    const option = question.options.find((o) => o.label.trim() === typed);
    if (!option && !question.other) return null;
    const sent = option ? (option.value ?? option.label) : typed;
    if (!answer.includes(sent)) answer.push(sent);
  }
  return question.multiSelect || answer.length === 1 ? answer : null;
}

// A typed message as the values of `question`: an option's number ("2"), several
// for a multiple choice ("1, 3"), else the text itself.
function typedValues(question, message) {
  const typed = typeof message === "string" ? message.trim() : "";
  const parts = question.multiSelect ? typed.split(/\s*,\s*/) : [typed];
  const numbered = parts.every(
    (part) =>
      /^\d{1,2}$/.test(part) &&
      Number(part) >= 1 &&
      Number(part) <= question.options.length,
  );
  return numbered
    ? parts.map((part) => question.options[Number(part) - 1].label)
    : [typed];
}

export class AgentQuestions {
  constructor(service, { now = Date.now } = {}) {
    Object.assign(this, { s: service, now });
    this.pending = new Map();
    // Requests that ended a moment ago, so a listing read before their end does not
    // bring them back (resync).
    this.ended = new Map();
    const hub = service.gatewayEvents;
    hub?.on("question.requested", (payload) => this.requested(payload));
    hub?.on("question.resolved", (payload) => this.resolved(payload));
    hub?.onReady?.(() => this.resync());
  }

  requested(payload) {
    const id = text(payload?.id, 200);
    const request = payload?.request;
    if (!id || !request || typeof request.sessionKey !== "string") return;
    // A request asked again (Hermes after a restart, a listing after a reconnect)
    // keeps what the Telegram chat answered so far and is not announced twice.
    const known = this.pending.get(id);
    const questions = (Array.isArray(request.questions) ? request.questions : [])
      .slice(0, 3)
      .map(questionOf);
    const conversation = this.s.store
      .listConversations()
      .find((c) => c.runtimeSessionKey === request.sessionKey && !c.archivedAt);
    const assistant = conversation && this.s.store.getAssistant(conversation.assistantId);
    // A question of no chat AgentPier knows, or one it cannot show: nobody can
    // answer it. A runtime that cannot be told so waits for its own timeout.
    if (
      !assistant ||
      assistant.runtimeAgentId !== request.agentId ||
      !questions.length ||
      !questions.every(Boolean)
    )
      return this.decline(request.sessionKey, id);
    const question = {
      id,
      conversationId: conversation.id,
      assistantId: assistant.id,
      sessionKey: request.sessionKey,
      runId: request.runId ?? null,
      questions,
      createdAt: Number.isSafeInteger(payload.createdAtMs)
        ? payload.createdAtMs
        : this.now(),
      expiresAt: Number.isSafeInteger(payload.expiresAtMs) ? payload.expiresAtMs : null,
      telegram: followUpTelegram(this.s, this.s.channels, assistant, conversation),
      // The paired Telegram chat answers one question after another: the answers it
      // gave so far, in the questions' order.
      typed: known?.typed ?? [],
    };
    this.pending.set(id, question);
    if (question.telegram && !known) this.notify(question);
    this.s.changed?.({ conversationId: conversation.id });
  }

  decline(sessionKey, id) {
    try {
      const { approvals } = runtimeForSession(sessionKey, this.s.runtime);
      if (typeof approvals?.decline !== "function") return;
      Promise.resolve(approvals.decline({ id })).catch(() => {});
    } catch {
      // The runtime is away: its own timeout ends the question.
    }
  }

  // The question the paired Telegram chat answers next, as a notice in the channel's
  // language: the agent's name, the question, its numbered options and how to answer.
  notify(question) {
    try {
      const channels = this.s.channels;
      const channel = channels.store.get(question.telegram.channelId);
      const copy = telegramQuestionMessages(channel);
      const name = this.s.store.getAssistant(question.assistantId).name;
      const step = question.typed.length;
      const total = question.questions.length;
      const asked = question.questions[step];
      const lines = [
        total > 1
          ? copy.telegramQuestionStep(name, step + 1, total, asked.text)
          : copy.telegramQuestion(name, asked.text),
        ...asked.options.map(
          (option, i) =>
            `${i + 1}. ${option.label}${option.description ? ` – ${option.description}` : ""}`,
        ),
        "",
        !asked.options.length
          ? copy.telegramQuestionAnswer
          : asked.multiSelect
            ? copy.telegramQuestionSeveral
            : copy.telegramQuestionChoices,
      ];
      channels.outbox.enqueue({
        key: step ? `question:${question.id}:${step}` : `question:${question.id}`,
        source: question.telegram,
        kind: "question",
        text: lines.join("\n"),
      });
    } catch {
      // The question still waits in the chat; Telegram is an extra.
    }
  }

  resolved(payload) {
    const id = text(payload?.id, 200);
    if (id) this.ended.set(id, this.now());
    const question = this.pending.get(id);
    if (!question) return;
    this.drop(question);
  }

  drop(question) {
    this.pending.delete(question.id);
    this.s.changed?.({ conversationId: question.conversationId });
  }

  /**
   * Reconciles with what the shared host still waits on, after its connection became
   * ready: events sent while it was away are lost, so questions it no longer lists
   * leave and listed ones AgentPier missed are taken up. Agents on a host of their
   * own (Hermes) ask again themselves.
   */
  async resync() {
    const { approvals } = runtimeFor(null, this.s.runtime);
    if (typeof approvals?.questions !== "function") return;
    const since = this.now();
    for (const [id, at] of this.ended) if (since - at > 60000) this.ended.delete(id);
    const listed = await approvals.questions();
    const waiting = new Set(listed.map((item) => item.id));
    for (const question of [...this.pending.values()])
      if (
        !ownHostSessionKey(question.sessionKey) &&
        question.createdAt <= since &&
        !waiting.has(question.id)
      )
        this.drop(question);
    for (const item of listed) if (!this.ended.has(item.id)) this.requested(item);
  }

  /** The questions waiting in chat `conversationId`, oldest first. */
  list(conversationId) {
    const now = this.now();
    return [...this.pending.values()]
      .filter((q) => q.conversationId === conversationId && !(q.expiresAt <= now))
      .map(({ telegram: _telegram, sessionKey: _key, typed: _typed, ...shown }) => ({
        ...shown,
        questions: shown.questions.map((question) => ({
          ...question,
          options: question.options.map(({ value: _value, ...option }) => option),
        })),
      }));
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

  waiting(conversationId, id) {
    const question = this.pending.get(id);
    if (!question || question.conversationId !== conversationId)
      throw assistantProblem("notFound", 404);
    return question;
  }

  /**
   * Sends the owner's answers to request `id` of `conversationId`: `answers` maps
   * each question's id to its values (options' labels, an own text), or `answer` is
   * the one value of a request's only question (an option's number counts as its
   * label). Refuses an unknown request (404), answers that leave a question open or
   * that a question does not take, and overlong ones (400), and a request the runtime
   * no longer waits for (409, it is gone then).
   */
  async answer(conversationId, id, input) {
    const question = this.waiting(conversationId, id);
    const given =
      input?.answers && typeof input.answers === "object" && !Array.isArray(input.answers)
        ? input.answers
        : question.questions.length === 1
          ? {
              [question.questions[0].id]: typedValues(
                question.questions[0],
                input?.answer,
              ),
            }
          : null;
    if (
      !given ||
      Object.keys(given).some((key) => !question.questions.some((q) => q.id === key))
    )
      throw assistantProblem("invalid");
    const answers = {};
    for (const asked of question.questions) {
      const values =
        Object.hasOwn(given, asked.id) && answerValues(asked, given[asked.id]);
      if (!values) throw assistantProblem("invalid");
      answers[asked.id] = values;
    }
    return this.send(question, answers);
  }

  /**
   * Takes `message`, typed in the paired Telegram chat, as the answer to the question
   * of request `id` asked there last. Resolves `{ ok, id, more }`: with `more` the
   * next question went out as a notice; without, the answers reached the runtime.
   * Refusals as answer().
   */
  async answerTyped(conversationId, id, message) {
    const question = this.waiting(conversationId, id);
    const asked = question.questions[question.typed.length];
    const values = asked && answerValues(asked, typedValues(asked, message));
    if (!values) throw assistantProblem("invalid");
    question.typed.push(values);
    if (question.typed.length < question.questions.length) {
      this.notify(question);
      return { ok: true, id, more: true };
    }
    const answers = Object.fromEntries(
      question.questions.map((q, i) => [q.id, question.typed[i]]),
    );
    try {
      return await this.send(question, answers);
    } catch (error) {
      // The message is tried again once the runtime is back.
      question.typed.pop();
      throw error;
    }
  }

  async send(question, answers) {
    const { id } = question;
    if (Object.values(answers).flat().join("").length > maxAnswerLength)
      throw assistantProblem("invalid");
    const runtime = runtimeForSession(question.sessionKey, this.s.runtime);
    try {
      await runtime.approvals.answer({ id, answers });
    } catch (error) {
      if (error?.invalid) throw assistantProblem("invalid");
      if (!error?.answered) throw assistantProblem("unavailable", 503);
      this.ended.set(id, this.now());
      this.drop(question);
      throw assistantProblem("questionGone", 409);
    }
    this.ended.set(id, this.now());
    this.drop(question);
    return { ok: true, id };
  }
}
