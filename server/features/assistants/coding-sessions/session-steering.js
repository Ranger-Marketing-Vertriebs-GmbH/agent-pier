import { createHash } from "node:crypto";
import { assistantProblem } from "../assistant-validation.js";
import { sessionScope } from "../../chat/chat-delivery.js";
import { control } from "./session-control.js";

const invalid = () => assistantProblem("invalid");
const text = (value, max) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= max &&
  !/[\u0000-\u001f\u007f]/.test(value);
const integer = (value, min, max, fallback) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw invalid();
  return value;
};

// Read bounds: replies per call, characters per reply and per call.
export const readBounds = { limit: 3, maxLimit: 10, replyChars: 8000, totalChars: 24000 };
// Wait: one activity reading per second for 1-100 s; after a send an idle reading
// counts once the turn was seen working or this long after the send.
export const waitBounds = { pollMs: 1000, timeoutSeconds: 60, maxSeconds: 100 };
export const settleMs = 5000;
const deliveryStatuses = new Set(["pending", "handed-off", "rejected", "uncertain"]);

// A UUID derived from a stable key, so a retried call reuses its delivery.
function deliveryUuid(key) {
  const hex = createHash("sha256").update(key).digest("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

// The session's activity as the agent sees it: a stopped session has ended.
const stateOf = (state) => (state === "stopped" ? "ended" : state);

async function activity(w, session) {
  return stateOf((await w.s.activity.read(session)).state);
}

// Open permission prompts and questions of the session (side-effect free).
export function pendingPrompts(w, sessionId) {
  const all = w.s.requests?.listAll?.() ?? [];
  return all.filter((e) => e.sessionId === sessionId && e.status === "pending").length;
}

/**
 * send: the agent's prompt into its session through ChatDelivery, at most once per
 * `requestId` (or, without one, per tool call). A message held behind an open
 * prompt answers `pending`; it is delivered once the prompt is answered.
 */
export async function sendToSession(w, ctx, input, inv) {
  if (
    typeof input.text !== "string" ||
    !input.text.trim() ||
    input.text.length > 32000 ||
    (input.requestId !== undefined && !text(input.requestId, 100))
  )
    throw invalid();
  const { record, session } = await control(w, ctx.assistantId, input.sessionId);
  const callKey =
    input.requestId ??
    `${ctx.hook?.key || ctx.routine?.key || ctx.attemptId}:${inv?.toolCallId}`;
  const deliveryId = deliveryUuid(`${ctx.assistantId}:${record.sessionId}:${callKey}`);
  const receipt = await w.s.chatDelivery.send(record.sessionId, {
    deliveryId,
    deliveryScope: sessionScope(session),
    text: input.text,
    submit: true,
  });
  const status = deliveryStatuses.has(receipt?.status) ? receipt.status : "uncertain";
  if (status !== "rejected") {
    const at = w.sessions.now();
    w.sessions.store.patch(record.sessionId, {
      lastSentAt: at,
      seen: { state: "working", at },
    });
  }
  audit(w, record, session, {
    ...(text(input.requestId, 100) ? { requestId: input.requestId } : {}),
    deliveryId,
    status,
  });
  return {
    deliveryId,
    status,
    ...(typeof receipt?.reason === "string" ? { reason: receipt.reason } : {}),
  };
}

// Ids and enums only (audit-agent-session-details.js); never the prompt.
function audit(w, record, session, details) {
  try {
    w.s.audit?.append({
      action: "session.sent",
      resourceType: "session",
      source: "system",
      outcome: details.status === "rejected" ? "failure" : "success",
      sessionId: record.sessionId,
      projectId: record.projectId,
      details: {
        tool: session.tool,
        agentSession: { assistantId: record.assistantId, op: "send", ...details },
      },
    });
  } catch (error) {
    console.error("Agent session audit failed:", error?.message);
  }
}

/**
 * read: the session's newest assistant replies after the message `after` (all of
 * them without it), at most `limit`, each cut to 8000 and together to 24000
 * characters. Untrusted data for the agent.
 */
export async function readSession(w, ctx, input) {
  if (input.after !== undefined && !text(input.after, 200)) throw invalid();
  const limit = integer(input.limit, 1, readBounds.maxLimit, readBounds.limit);
  const { record, session } = await control(w, ctx.assistantId, input.sessionId);
  const messages = (await w.s.chat.read(record.sessionId))?.messages ?? [];
  const from =
    input.after === undefined ? 0 : messages.findIndex((m) => m?.id === input.after) + 1;
  const candidates = messages
    .slice(from)
    .filter(
      (m) =>
        m?.role === "assistant" &&
        m.status !== "failed" &&
        typeof m.text === "string" &&
        m.text.trim().length > 0,
    )
    .slice(-limit);
  const replies = [];
  let budget = readBounds.totalChars;
  for (const m of candidates.reverse()) {
    if (budget <= 0) break;
    const cut = m.text.slice(0, Math.min(readBounds.replyChars, budget));
    budget -= cut.length;
    replies.unshift({
      id: String(m.id),
      text: cut,
      truncated: cut.length < m.text.length,
    });
  }
  const state = await activity(w, session);
  w.sessions.store.patch(record.sessionId, { seen: { state, at: w.sessions.now() } });
  return {
    replies,
    cursor: replies.at(-1)?.id ?? input.after ?? null,
    pendingPrompts: pendingPrompts(w, record.sessionId),
    state,
  };
}

/**
 * wait: polls the session's activity once a second until it is idle, waits for an
 * answer or ended, or `timeoutSeconds` passed (state `working`, reason `timeout`).
 * After a send an idle reading counts only once the turn was seen working or 5 s
 * passed. Every poll re-checks the turn and control, so a session the owner deleted
 * answers NOT_FOUND and a revoked grant GRANT_REVOKED.
 */
export async function waitForSession(w, ctx, input, inv) {
  const seconds = integer(
    input.timeoutSeconds,
    1,
    waitBounds.maxSeconds,
    waitBounds.timeoutSeconds,
  );
  const sessions = w.sessions;
  let { record, session } = await control(w, ctx.assistantId, input.sessionId);
  const sessionId = record.sessionId;
  const deadline = sessions.now() + seconds * 1000;
  let turnStarted = false;
  sessions.waiting.add(sessionId);
  try {
    for (;;) {
      const state = await activity(w, session);
      if (state === "working") turnStarted = true;
      const settled =
        turnStarted ||
        typeof record.lastSentAt !== "number" ||
        sessions.now() - record.lastSentAt >= settleMs;
      if (state === "waiting" || state === "ended" || (state === "idle" && settled))
        return finish(w, sessionId, state, state);
      if (sessions.closed || sessions.now() >= deadline)
        return finish(w, sessionId, "working", "timeout");
      await sessions.sleep(waitBounds.pollMs);
      inv?.assertCurrent?.();
      ({ record, session } = await control(w, ctx.assistantId, sessionId));
    }
  } finally {
    sessions.waiting.delete(sessionId);
  }
}

function finish(w, sessionId, state, reason) {
  w.sessions.store.patch(sessionId, { seen: { state, at: w.sessions.now() } });
  return { state, reason, pendingPrompts: pendingPrompts(w, sessionId) };
}
