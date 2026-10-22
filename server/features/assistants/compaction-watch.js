// How AgentPier learns that a summary on request (long-chats.js) ended after the
// request's answer was given up on. OpenClaw 2026.10.3 (sessions-compact) runs the
// summary inside runExclusiveSessionLifecycleMutation("compact") and holds the
// session's lifecycle lock until it committed; chat.send meanwhile waits for it. The
// end shows in three ways, whichever comes first:
// - the `sessions.compact` answer itself: long-chats.js keeps the request open;
// - the Gateway event `session.operation` { operationId, operation: "compact",
//   phase: "end", sessionKey (canonical), agentId, completed, reason, ts }, sent right
//   before that answer (sessions-shared emitSessionOperation). OpenClaw sends it only
//   to connections that called `sessions.subscribe`, which also streams every
//   session's changes; a separate connection subscribes here, so the main one's
//   event handling (gateway-wiring.js) stays as it is;
// - read-only: a new compaction marker in chat.history (`__openclaw.kind:
//   "compaction"`, conversations.js), polled every `pollMs`.

const markerOf = (history) =>
  (Array.isArray(history?.messages) ? history.messages : [])
    .filter((m) => m?.__openclaw?.kind === "compaction" && m.__openclaw.id)
    .map((m) => String(m.__openclaw.id))
    .at(-1) ?? null;
const sameSession = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();

/** Whether a Gateway event frame ends the compaction of `sessionKey`; its outcome. */
export function compactEndOf(frame, sessionKey) {
  const p = frame?.payload;
  if (
    frame?.event !== "session.operation" ||
    p?.operation !== "compact" ||
    p.phase !== "end" ||
    !sameSession(p.sessionKey, sessionKey)
  )
    return null;
  return p.completed === true ? "compacted" : "failed";
}

/**
 * Watches the session until its compaction ends, then calls `onEnd` once with
 * "compacted", "failed" or "interrupted" (`alive()` turned false: the Gateway that
 * ran it is gone). Returns `stop()`, which ends the watch without calling `onEnd`.
 */
export function watchCompactEnd({ client, sessionKey, pollMs, alive, onEnd }) {
  let stopped = false;
  let watcher = null;
  let baseline;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    watcher?.close();
  };
  const end = (outcome) => {
    if (stopped) return;
    stop();
    onEnd(outcome);
  };
  const listen = async () => {
    const sibling = client.sibling?.();
    if (!sibling) return;
    watcher = sibling;
    try {
      await sibling.connect();
      if (stopped) return sibling.close();
      sibling.subscribe((frame) => {
        const outcome = compactEndOf(frame, sessionKey);
        if (outcome) end(outcome);
      });
      await sibling.call("sessions.subscribe", {});
    } catch {
      // The marker poll and the request's own answer remain.
      sibling.close();
    }
  };
  const read = async () => {
    const marker = markerOf(await client.call("chat.history", { sessionKey, limit: 20 }));
    if (stopped) return;
    if (baseline === undefined) baseline = marker;
    else if (marker && marker !== baseline) end("compacted");
  };
  const timer = setInterval(() => {
    if (!alive()) return end("interrupted");
    read().catch(() => {});
  }, pollMs);
  timer.unref?.();
  read().catch(() => {});
  listen();
  return stop;
}
