import { assistantProblem } from "../assistant-validation.js";
import { notifyAction } from "../assistant-action-notifications.js";
import { pairedChannel, telegramTarget } from "../routine-targets.js";
import { control, stillGranted } from "./session-control.js";
import {
  escalationKey,
  openPrompts,
  promptGone,
  promptIdValue,
} from "./session-requests.js";

const invalid = () => assistantProblem("invalid");
const titleLimit = 200;
// A note may span lines; no other control characters.
const noteValue = (value) =>
  typeof value === "string" &&
  value.length <= 1000 &&
  !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);

/** The tool's answer for an escalation, as stored. */
export const escalationResult = (a) => ({ actionId: a.id, state: a.state });

// What the prompt asks, as the inbox names it: the question, or the tool it wants to
// use; never a command line.
function promptTitle(entry) {
  const first = entry.questions?.[0];
  const subject = entry.subject || {};
  const title =
    entry.kind === "question"
      ? first?.header || first?.prompt || first?.question
      : entry.presentation
        ? ""
        : subject.description || subject.tool || subject.name;
  return typeof title === "string"
    ? title.replace(/\s+/g, " ").trim().slice(0, titleLimit)
    : "";
}

// The owner's paired Telegram chat on the agent, where the escalation also asks.
function pairedTelegram(w, assistantId) {
  try {
    const channel = pairedChannel(w.s.assistantChannels, assistantId);
    return channel ? telegramTarget(channel) : null;
  } catch {
    return null;
  }
}

/**
 * escalate: hands an open prompt of the agent's session to the owner, with an
 * optional note. One action per prompt (key `escalate:<sessionId>:<promptId>`,
 * state `awaiting_approval`) in the conversation of the turn: the owner's chat card
 * answers it through the session's own request endpoint, and the inbox marks the
 * request itself as escalated. Escalating again returns that action. A prompt no
 * longer open is PROMPT_ANSWERED; one of another session NOT_FOUND.
 */
export async function escalatePrompt(w, ctx, input, inv) {
  if (!promptIdValue(input.promptId)) throw invalid();
  if (input.note !== undefined && !noteValue(input.note)) throw invalid();
  const { record, session } = await control(w, ctx.assistantId, input.sessionId);
  const { sessionId } = record,
    { promptId } = input;
  const key = escalationKey(sessionId, promptId);
  const existing = w.store.byKey(key);
  if (existing) return escalationResult(existing);
  const entry = (await openPrompts(w, sessionId)).find((e) => e.id === promptId);
  if (!entry)
    throw Object.assign(assistantProblem("promptAnswered", 409), {
      answeredBy: promptGone(w, sessionId, promptId),
    });
  // The turn may have ended while the prompt was read: never escalate for it.
  inv?.assertCurrent?.();
  const action = w.store.reserve({
    assistantId: ctx.assistantId,
    conversationId: ctx.conversationId,
    attemptId: ctx.attemptId ?? null,
    origin: ctx.origin,
    key,
    payload: {
      action: "session_request",
      sessionId,
      promptId,
      sessionName: session.name ?? null,
      kind: entry.kind,
      title: promptTitle(entry),
      note: input.note?.trim() || null,
    },
    state: "awaiting_approval",
    telegram: pairedTelegram(w, ctx.assistantId),
  });
  w.a.changed();
  // The request's own push, held while the agent controls the session (Task 12).
  try {
    await w.s.operationsEvents?.releaseRequest?.(promptId);
  } catch (error) {
    console.error("Releasing an escalated request failed:", error?.message);
  }
  audit(w, record, session, action);
  return escalationResult(action);
}

// Whether the prompt still waits in its running session (being answered counts).
async function promptOpen(w, sessionId, promptId) {
  try {
    const session = await w.s.sessions.get(sessionId);
    if (session?.status !== "running") return false;
    const { requests = [] } = await w.s.requests.list(sessionId);
    return requests.some(
      (e) =>
        e.id === promptId &&
        e.sessionId === sessionId &&
        ["pending", "responding"].includes(e.status),
    );
  } catch (error) {
    if (error?.status === 404) return false;
    throw error;
  }
}

/**
 * The action tick of an escalation (AssistantWorkflows.advanceAction): cancelled
 * once the agent no longer controls the session (GRANT_REVOKED); while the prompt
 * waits, asks on Telegram; once it is gone, completed with who answered it (owner,
 * agent, telegram, or the session itself when it ended or moved on) and the agent's
 * follow-up turn marked pending.
 */
export async function advanceEscalation(w, a) {
  const { sessionId, promptId } = a.payload;
  if (a.state === "awaiting_approval") {
    const record = w.sessions.store.get(sessionId);
    if (!record || record.assistantId !== a.assistantId || !stillGranted(w, record)) {
      w.store.patch(a.id, {
        state: "cancelled",
        diagnostic: "GRANT_REVOKED",
        settled: true,
      });
      return;
    }
    if (await promptOpen(w, sessionId, promptId)) {
      notifyAction(w, a, "approval");
      return;
    }
    a = w.store.patch(a.id, {
      state: "completed",
      result: { answeredBy: w.sessions.answeredBy(promptId) },
    });
  }
  if (a.state === "completed") {
    notifyAction(w, a, "result");
    // One wake turn tells the agent who answered (Task 11 delivers it and settles).
    if (!a.followUp) w.store.patch(a.id, { followUp: { pending: true } });
    return;
  }
  if (!a.settled) w.store.patch(a.id, { settled: true });
}

// Ids and enums only (audit-agent-session-details.js); never the note or the prompt.
function audit(w, record, session, action) {
  try {
    w.s.audit?.append({
      action: "session.escalated",
      resourceType: "session",
      source: "system",
      outcome: "success",
      sessionId: record.sessionId,
      projectId: record.projectId,
      details: {
        tool: session.tool,
        agentSession: {
          assistantId: record.assistantId,
          op: "escalate",
          actionId: action.id,
          promptId: action.payload.promptId,
        },
      },
    });
  } catch (error) {
    console.error("Agent session audit failed:", error?.message);
  }
}
