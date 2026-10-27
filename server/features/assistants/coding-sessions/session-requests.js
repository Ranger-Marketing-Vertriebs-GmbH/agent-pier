import { assistantProblem } from "../assistant-validation.js";
import { control } from "./session-control.js";

const invalid = () => assistantProblem("invalid");
const notFound = () => assistantProblem("notFound", 404);
const plain = (value) => !!value && typeof value === "object" && !Array.isArray(value);
export const promptIdValue = (value) =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 100 &&
  !/[\u0000-\u001f\u007f]/.test(value);

// The escalation of a prompt to the owner (escalate), by its action key.
export const escalationKey = (sessionId, promptId) => `escalate:${sessionId}:${promptId}`;

// The session's open prompts as the broker lists them: pending ones only.
export async function openPrompts(w, sessionId) {
  const { requests = [] } = await w.s.requests.list(sessionId);
  return requests.filter((e) => e.sessionId === sessionId && e.status === "pending");
}

/**
 * requests: the open permission prompts and questions of the agent's session, as the
 * broker lists them (untrusted data for the agent), each marked when the agent
 * escalated it to the owner. Patches `seen` to the session's current state.
 */
export async function listPrompts(w, ctx, input) {
  const { record, session } = await control(w, ctx.assistantId, input.sessionId);
  const prompts = (await openPrompts(w, record.sessionId)).map((e) => ({
    id: e.id,
    kind: e.kind,
    presentation: e.presentation ?? null,
    revision: e.revision,
    options: e.options ?? [],
    questions: e.questions ?? [],
    subject: e.subject ?? null,
    escalated: !!w.store.byKey(escalationKey(record.sessionId, e.id)),
  }));
  const reading = (await w.s.activity.read(session)).state;
  const state = reading === "stopped" ? "ended" : reading;
  w.sessions.store.patch(record.sessionId, { seen: { state, at: w.sessions.now() } });
  return { prompts };
}

/**
 * Who answered a prompt that is no longer open in the agent's session: owner, agent
 * or telegram as the broker's events named it, else the session itself. A prompt of
 * another session throws NOT_FOUND, so it is never confirmed to exist.
 */
export function promptGone(w, sessionId, promptId) {
  const other = w.s.requests.listAll?.().find((e) => e.id === promptId);
  const known = w.sessions.answers.get(promptId);
  if (
    (other && other.sessionId !== sessionId) ||
    (known && known.sessionId !== sessionId)
  )
    throw notFound();
  return known?.actor ?? "session";
}

// Exactly one of choice, answers or decline: true; notes only beside answers or decline.
function answerInput(input) {
  const given = ["choice", "answers", "decline"].filter((k) => input[k] !== undefined);
  if (
    !promptIdValue(input.promptId) ||
    given.length !== 1 ||
    (input.choice !== undefined && typeof input.choice !== "string") ||
    (input.answers !== undefined && !plain(input.answers)) ||
    (input.decline !== undefined && input.decline !== true) ||
    (input.notes !== undefined && (!plain(input.notes) || input.choice !== undefined))
  )
    throw invalid();
  const answer = {};
  for (const key of ["choice", "answers", "decline", "notes"])
    if (input[key] !== undefined) answer[key] = input[key];
  return answer;
}

/**
 * answer: the agent answers an open prompt of its session at its live revision. The
 * first answer wins (request-broker.js): a prompt someone else answered, or that
 * changed or went away, is PROMPT_ANSWERED naming who answered it (`answeredBy`:
 * owner, agent, telegram, or the session itself when nobody is known). A prompt of
 * another session is NOT_FOUND, never confirmed.
 */
export async function answerPrompt(w, ctx, input, inv) {
  const answer = answerInput(input);
  const { record, session } = await control(w, ctx.assistantId, input.sessionId);
  const sessionId = record.sessionId,
    promptId = input.promptId;
  const answered = (by) => {
    audit(w, record, session, promptId, "failure");
    return Object.assign(assistantProblem("promptAnswered", 409), { answeredBy: by });
  };
  const entry = (await openPrompts(w, sessionId)).find((e) => e.id === promptId);
  if (!entry) throw answered(promptGone(w, sessionId, promptId));
  // The turn may have ended while the list was read: never answer for a stale turn.
  inv?.assertCurrent?.();
  try {
    await w.s.requests.answer(
      sessionId,
      promptId,
      { expectedRevision: entry.revision, ...answer },
      false,
      { kind: "agent", assistantId: ctx.assistantId },
    );
  } catch (error) {
    if (error?.stale !== true) throw error;
    throw answered(error.answeredBy ?? w.sessions.answeredBy(promptId));
  }
  audit(w, record, session, promptId, "success");
  return { answered: true };
}

// Ids and enums only (audit-agent-session-details.js); never the answer.
function audit(w, record, session, promptId, outcome) {
  try {
    w.s.audit?.append({
      action: "session.answered",
      resourceType: "session",
      source: "system",
      outcome,
      sessionId: record.sessionId,
      projectId: record.projectId,
      details: {
        tool: session.tool,
        agentSession: { assistantId: record.assistantId, op: "answer", promptId },
      },
    });
  } catch (error) {
    console.error("Agent session audit failed:", error?.message);
  }
}
