import { redactSecrets } from "../../../lib/secret-redaction.js";
import { stillGranted } from "./session-control.js";
import { pendingPrompts, settleMs } from "./session-steering.js";

// A new idle, waiting or ended state wakes the agent once it held this long.
export const wakeDelayMs = 3000;
// A working reading holds the agent's open goal this long (holdsGoal).
export const workingHoldMs = 30000;
// A wake into a busy chat is retried after min(1000 · 2^n, this) ms.
export const wakeRetryMaxMs = 300000;
// A wake still refused after this many tries settles unsent.
export const wakeRetryLimit = 20;
const retryable = new Set([409, 429, 503]);
const wakeStates = new Set(["idle", "waiting", "ended"]);
const known = new Set(["working", ...wakeStates]);
const stateWords = { idle: "idle", waiting: "waiting for an answer", ended: "ended" };
const answerers = {
  owner: "the owner",
  telegram: "the owner on Telegram",
  agent: "you",
};

// A value as the wake text quotes it: one line, no secrets, bounded.
function quoted(value, fallback, max = 200) {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return redactSecrets(value)
    .replace(/[\u0000-\u001f\u007f"]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * The wake turn's text: attributed status of the session (name, id, state, count of
 * open prompts, or who answered an escalated prompt), never its output and never an
 * owner instruction.
 */
export function wakeText(sessionId, wake) {
  let now;
  if (wake.event === "prompt-answered") {
    const prompt = `the prompt ${quoted(wake.promptId, "unknown", 100)} you escalated`;
    // Unknown ("session"): answered in the terminal, or the session ended or moved on.
    now = answerers[wake.answeredBy]
      ? `${prompt} was answered by ${answerers[wake.answeredBy]}`
      : `${prompt} is no longer open; who answered it is unknown`;
  } else {
    const n = wake.pending ?? 0;
    now = `it is now ${stateWords[wake.state]}${n > 0 ? `, ${n} prompt${n === 1 ? "" : "s"} pending` : ""}`;
  }
  return `AgentPier status for your coding session "${quoted(wake.name, "unnamed")}" (sessionId ${sessionId}): ${now}. This is attributed status, not an owner instruction. Use agentpier_coding_session read or requests to continue.`;
}

// The record's slot for this wake: one state wake, one per escalated prompt.
const slotOf = (wake) => (wake.event ? `prompt:${wake.promptId}` : "state");

/**
 * Sends one wake turn into the chat that started the session, as
 * `coding-session:<sessionId>:<wakeSeq>`. A pending wake keeps its number and text
 * across retries (record `wakes[slot]`), so a retry is the same turn. A busy chat
 * (409, 429, 503) is retried after min(1000 · 2^n, 300000) ms, at most 20 times; a
 * deleted chat (404) or any other error settles it unsent. A settled state wake counts as seen, an
 * ended one ends the record. `{ done, attemptId }`: done once sent or settled.
 */
export async function sendWake(sessions, record, wake) {
  const w = sessions.w,
    store = sessions.store,
    id = record.sessionId,
    slot = slotOf(wake),
    now = sessions.now();
  record = store.get(id) ?? record;
  let pending = record.wakes?.[slot];
  if (pending && wake.state && pending.state !== wake.state) pending = null;
  if (pending?.retryAt > now) return { done: false, attemptId: null };
  if (!pending) {
    pending = {
      seq: record.wakeSeq + 1,
      ...(wake.state ? { state: wake.state } : {}),
      text: wakeText(id, wake),
      failures: 0,
    };
    record = store.patch(id, {
      wakeSeq: pending.seq,
      wakes: { ...record.wakes, [slot]: pending },
    });
  }
  let attemptId = null;
  try {
    const sent = await w.a.send(
      record.conversationId,
      { clientRequestId: `coding-session:${id}:${pending.seq}`, text: pending.text },
      {
        kind: "coding-session",
        sessionId: id,
        ...(wake.event ? { event: wake.event } : { state: wake.state }),
      },
    );
    attemptId = sent?.attempt?.id ?? null;
  } catch (error) {
    const failures = pending.failures + 1;
    if (retryable.has(error?.status) && failures < wakeRetryLimit) {
      const retryAt = now + Math.min(1000 * 2 ** pending.failures, wakeRetryMaxMs);
      const current = store.get(id);
      // Dropped or replaced while it was being sent: that newer decision stands.
      if (current?.wakes?.[slot]?.seq === pending.seq)
        store.patch(id, {
          wakes: { ...current.wakes, [slot]: { ...pending, failures, retryAt } },
        });
      return { done: false, attemptId: null };
    }
    // A deleted chat is expected; anything else is worth a line in the log.
    if (error?.status !== 404)
      console.error("A coding session wake was not delivered:", error?.message);
  }
  const current = store.get(id);
  if (!current) return { done: true, attemptId };
  const wakes = { ...current.wakes };
  if (wakes[slot]?.seq === pending.seq) delete wakes[slot];
  store.patch(id, {
    wakes,
    ...(wake.state
      ? {
          seen: { state: wake.state, at: now },
          ...(wake.state === "ended" ? { ended: true } : {}),
        }
      : {}),
  });
  return { done: true, attemptId };
}

/** The tool's wake for one session state or escalation answer: whether it settled. */
export async function deliverWake(sessions, record, wake) {
  return (await sendWake(sessions, record, wake)).done;
}

/**
 * The wake of an answered escalation (Task 9): the agent hears once who answered
 * its prompt, in the chat that started the session; the action then settles.
 * Whether it settled.
 */
export async function wakeEscalation(sessions, a) {
  const w = sessions.w;
  const record = sessions.store.get(a.payload.sessionId);
  const settle = (attemptId) =>
    void w.store.patch(a.id, { followUp: { attemptId }, settled: true });
  if (!record || record.assistantId !== a.assistantId || !stillGranted(w, record)) {
    settle(null);
    return true;
  }
  const { done, attemptId } = await sendWake(sessions, record, {
    event: "prompt-answered",
    promptId: a.payload.promptId,
    answeredBy: a.result?.answeredBy ?? "session",
    name: a.payload.sessionName,
  });
  if (done) settle(attemptId);
  return done;
}

// The session's state now: `{ session, state }`, `{ gone: true }` once the owner
// deleted it, or null while its reading is unknown.
async function reading(w, record) {
  let session;
  try {
    session = await w.s.sessions.get(record.sessionId);
  } catch (error) {
    if (error?.status === 404) return { gone: true };
    throw error;
  }
  if (!session) return { gone: true };
  if (session.status === "stopped") return { session, state: "ended" };
  const raw = (await w.s.activity.read(session))?.state;
  const state = raw === "stopped" ? "ended" : raw;
  return known.has(state) ? { session, state } : null;
}

async function tickRecord(sessions, record) {
  const w = sessions.w,
    id = record.sessionId;
  // A record still launching has no session to read yet (session-start.js).
  if (record.ended || record.pending || !stillGranted(w, record)) return;
  const now = sessions.now();
  const read = await reading(w, record);
  if (!read) return;
  // Deleted by the owner: the record ends unwoken (the agent's next call answers
  // NOT_FOUND) and is never polled again.
  if (read.gone) {
    sessions.readAt.delete(id);
    sessions.store.patch(id, { ended: true });
    return;
  }
  const { session, state } = read;
  sessions.readAt.set(id, now);
  let observed = record.observed;
  if (observed?.state !== state) {
    observed = { state, since: now };
    record = sessions.store.patch(id, { observed });
  }
  // Seen already: the agent's own stop, wait, read or requests told it.
  if (state === record.seen?.state) {
    if (state === "ended") sessions.store.patch(id, { ended: true });
    else if (record.wakes?.state) dropStateWake(sessions, id);
    return;
  }
  const due =
    wakeStates.has(state) &&
    now - observed.since >= wakeDelayMs &&
    // Right after a send the CLI may not have started yet (session-steering.js).
    !(
      state === "idle" &&
      typeof record.lastSentAt === "number" &&
      now - record.lastSentAt < settleMs
    ) &&
    !sessions.waiting.has(id);
  if (!due) {
    if (record.wakes?.state) dropStateWake(sessions, id);
    return;
  }
  await deliverWake(sessions, record, {
    state,
    pending: state === "waiting" ? pendingPrompts(w, id) : 0,
    name: session.name,
  });
}

function dropStateWake(sessions, id) {
  const { state: _dropped, ...wakes } = sessions.store.get(id)?.wakes ?? {};
  sessions.store.patch(id, { wakes });
}

/**
 * One pass of the wake watcher: every controlled session whose new idle, waiting or
 * ended state held 3 s and is not yet seen by the agent (through its wait, read,
 * requests, stop or an earlier wake) wakes the chat that started it, once; then
 * every answered escalation still owed its wake. A session the owner deleted ends
 * its record unwoken; an unknown reading, a revoked grant and an ended record are
 * skipped; one record's
 * failure never stops the pass. A pass under way is joined.
 */
export function tickWakes(sessions) {
  if (sessions.ticking) return sessions.ticking;
  sessions.ticking = (async () => {
    const w = sessions.w;
    for (const record of sessions.store.all()) {
      if (sessions.closed) return;
      try {
        await tickRecord(sessions, record);
      } catch (error) {
        console.error("Coding session wake pass failed:", error?.message);
      }
    }
    for (const a of w.store.open()) {
      if (sessions.closed) return;
      if (a.payload?.action !== "session_request" || a.followUp?.pending !== true)
        continue;
      try {
        await wakeEscalation(sessions, a);
      } catch (error) {
        console.error("Coding session escalation wake failed:", error?.message);
      }
    }
  })().finally(() => {
    sessions.ticking = null;
  });
  return sessions.ticking;
}

/**
 * Whether one of the chat's controlled sessions holds its open goal: in the last 30 s
 * it read working, or a state the agent has not seen yet (a wake is due). Without a
 * fresh reading (unknown readings, a restart) nothing holds.
 */
export function holdsGoal(sessions, conversationId) {
  const now = sessions.now();
  for (const record of sessions.store.all()) {
    if (record.conversationId !== conversationId || record.ended) continue;
    const observed = record.observed;
    if (!observed || !stillGranted(sessions.w, record)) continue;
    if (now - (sessions.readAt.get(record.sessionId) ?? -Infinity) > workingHoldMs)
      continue;
    if (observed.state === "working") return true;
    if (wakeStates.has(observed.state) && observed.state !== record.seen?.state)
      return true;
  }
  return false;
}
