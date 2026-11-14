// The scheduler of session talk (SessionTalk.tick): dispatches queued asks and
// tells into the agent's main chat in order, observes their turns, and settles the
// late ones by pasting the answer into the session while it still runs and may
// still talk to the agent. An open row holds back the later rows of its agent's
// main chat; one that keeps failing to advance fails after `stuckAttempts` passes,
// so it never blocks that chat for good.
import { runReply } from "../history-text.js";
import { mainConversation } from "../routine-targets.js";
import { sessionScope } from "../../chat/chat-delivery.js";
import { confirmedDelivery } from "../../chat/chat-delivery-blocked.js";
import { deliveryUuid } from "../coding-sessions/session-steering.js";
import { talkEligible } from "../../session-talk/session-agent-grants.js";
import { sessionHasTools, talkVia } from "./talk-reach.js";
import { askPrompt, lateAnswer, lateFailure, tellPrompt } from "./talk-text.js";

// Busy chat (409 `active`), too many turns (429), agent restarting (503): wait.
const busy = new Set([409, 429, 503]);
const dispatchAttempts = 5;
const stuckAttempts = 5;
const pasteAttempts = 5;
// An agent without a main chat (being replaced, or removed): wait this long, then fail.
export const noChatMs = 5 * 60_000;
// The answer pasted into a session, as the ask tool returns it.
export const answerChars = 24_000;

export const clientRequestId = (row) => `session-talk:${row.id}`;

/** The session the row was asked from, only while it is the same session (id and createdAt). */
async function sameSession(talk, row) {
  try {
    const session = await talk.w.s.sessions.get(row.sessionId);
    return (session.createdAt ?? null) === (row.sessionCreatedAt ?? null)
      ? session
      : null;
  } catch {
    return null;
  }
}

// Whether the agent may still talk to the session: running, eligible, granted.
const reachable = (talk, row, session) =>
  !!session &&
  session.status === "running" &&
  talkEligible(session) &&
  !!talkVia(talk.w, row.assistantId, session);

/** One pass over the open rows, oldest first; one agent's chat takes one turn at a time. */
export async function talkPass(talk) {
  const held = new Set();
  let changed = false;
  for (const row of talk.store.pending()) {
    if (talk.closed) break;
    const open = ["queued", "running"].includes(row.phase);
    try {
      let current = row;
      if (current.phase === "queued") {
        if (held.has(current.assistantId)) continue;
        current = await dispatch(talk, current);
      } else if (current.phase === "running") current = await observe(talk, current);
      if (["queued", "running"].includes(current.phase)) held.add(current.assistantId);
      if (current.late && ["answered", "failed"].includes(current.phase))
        current = await settleLate(talk, current);
      changed ||= current !== row;
    } catch (error) {
      console.error("A session talk message could not advance:", error?.message);
      if (!open) continue;
      // The row may have settled (or gone) before the step failed: leave it so.
      const now = talk.store.get(row.id);
      if (!now || !["queued", "running"].includes(now.phase)) continue;
      changed = true;
      // A missing attempt or an unreadable chat: retried a few passes, then failed.
      const stuck = (now.stuckFailures || 0) + 1;
      if (stuck < stuckAttempts) {
        talk.store.patch(row.id, { stuckFailures: stuck });
        held.add(row.assistantId);
      } else fail(talk, row, "ADVANCE_FAILED");
    }
  }
  if (changed) talk.changed();
}

function fail(talk, row, diagnostic) {
  return talk.store.patch(row.id, {
    phase: "failed",
    diagnostic,
    finishedAt: talk.now(),
  });
}

async function dispatch(talk, row) {
  const a = talk.w.a;
  const key = clientRequestId(row);
  // A send whose bookkeeping a crash lost is adopted, never sent twice.
  const existing = a.ledger
    .requests(row.conversationId)
    .find((x) => x.clientRequestId === key);
  let attemptId = existing ? a.ledger.attemptFor(existing.id)?.id : null;
  if (!attemptId) {
    // The grant must still hold when the turn starts.
    const session = await sameSession(talk, row);
    if (!reachable(talk, row, session)) return fail(talk, row, "GRANT_REVOKED");
    // The agent's main chat now: a model switch or a restart may have replaced it.
    const chat = mainConversation(a.store, row.assistantId);
    if (!chat) {
      // Waits while the chat is replaced; an agent left without one fails the row.
      const since = row.noChatSince ?? talk.now();
      if (talk.now() - since >= noChatMs) return fail(talk, row, "NO_CHAT");
      return row.noChatSince ? row : talk.store.patch(row.id, { noChatSince: since });
    }
    if (chat.id !== row.conversationId)
      row = talk.store.patch(row.id, { conversationId: chat.id });
    try {
      const sent = await a.send(
        row.conversationId,
        {
          clientRequestId: key,
          text: row.op === "ask" ? askPrompt(row) : tellPrompt(row),
        },
        {
          kind: "session-talk",
          requestId: row.id,
          sessionId: row.sessionId,
          sessionName: row.sessionName,
          projectName: row.projectName,
          tool: row.tool,
          op: row.op,
          display: row.text,
        },
      );
      attemptId = sent.attempt.id;
    } catch (error) {
      if (busy.has(error?.status)) return row;
      const failures = (row.dispatchFailures || 0) + 1;
      if (failures < dispatchAttempts)
        return talk.store.patch(row.id, { dispatchFailures: failures });
      return fail(talk, row, "DISPATCH_FAILED");
    }
  }
  return talk.store.patch(row.id, {
    phase: "running",
    noChatSince: undefined,
    attemptId,
    startedAt: talk.now(),
  });
}

async function observe(talk, row) {
  const a = talk.w.a;
  const attempt = a.ledger.getAttempt(row.attemptId);
  if (attempt.state === "completed") {
    // The chat the run ran in, though a model switch may have replaced it since.
    const chat = a.ledger.getRequest(attempt.requestId).conversationId;
    const history = await a.history(chat);
    if (history.stale) return row;
    const reply = await runReply(a, chat, history.messages, attempt);
    if (row.op === "ask" && !reply.text.trim()) return fail(talk, row, "NO_TEXT");
    return talk.store.patch(row.id, {
      phase: "answered",
      answer: reply.text,
      ...(reply.cut ? { cut: true } : {}),
      finishedAt: talk.now(),
    });
  }
  if (["failed", "cancelled"].includes(attempt.state))
    return fail(talk, row, attempt.state === "failed" ? "RUN_FAILED" : "RUN_CANCELLED");
  if (attempt.reviewedAt) return fail(talk, row, "OUTCOME_REVIEWED");
  return row;
}

/** The answer of an ask that stopped waiting: into the session, or only the agent's chat. */
async function settleLate(talk, row) {
  const store = talk.store;
  const lateId = `late:${row.id}`;
  const note = (phase, delivery = {}) => {
    const fields = {
      op: "late",
      direction: "to-session",
      assistantId: row.assistantId,
      conversationId: row.conversationId,
      sessionId: row.sessionId,
      projectId: row.projectId,
      sessionName: row.sessionName,
      projectName: row.projectName,
      tool: row.tool,
      via: row.via,
      text: row.phase === "answered" ? row.answer : "",
      phase,
      askId: row.id,
      ...delivery,
    };
    if (store.get(lateId)) store.patch(lateId, fields);
    else store.create({ ...fields, id: lateId });
    return store.patch(row.id, { phase, ...delivery, settledAt: talk.now() });
  };
  const session = await sameSession(talk, row);
  if (!reachable(talk, row, session)) return note("late-dropped");
  // Fenced under the agent's header with the same note as its own sends.
  const agent = { id: row.assistantId, name: row.agentName };
  const tools = sessionHasTools(talk.w, row.sessionId);
  const text =
    row.phase === "answered"
      ? lateAnswer(agent, row.text, row.answer.slice(0, answerChars), tools)
      : lateFailure(agent, row.text, tools);
  const deliveryId = deliveryUuid(`session-talk-late:${row.id}`);
  const delivery = talk.w.s.chatDelivery;
  let receipt;
  try {
    receipt = await confirmedDelivery(
      delivery,
      row.sessionId,
      await delivery.send(row.sessionId, {
        deliveryId,
        deliveryScope: sessionScope(session),
        text,
        submit: true,
      }),
    );
  } catch (error) {
    const failures = (row.pasteFailures || 0) + 1;
    if (error?.status !== 404 && failures < pasteAttempts)
      return store.patch(row.id, { pasteFailures: failures });
    return note("late-dropped", { deliveryId });
  }
  return note("late-delivered", {
    deliveryId,
    deliveryStatus: typeof receipt?.status === "string" ? receipt.status : "uncertain",
  });
}
