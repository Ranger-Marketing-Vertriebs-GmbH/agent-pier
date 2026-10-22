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

// The newest compaction marker of a chat.history page: { id, at } or null.
export function latestMarker(history) {
  const m = (Array.isArray(history?.messages) ? history.messages : [])
    .filter((m) => m?.__openclaw?.kind === "compaction" && m.__openclaw.id)
    .at(-1);
  return m ? { id: String(m.__openclaw.id), at: Number(m.timestamp) || 0 } : null;
}
const sameSession = (a, b) =>
  typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
// What a failed step logs: its code and the Gateway's error class, never its text.
const reasonOf = (error) =>
  `${error?.code || "unknown"}${error?.remoteError ? ` (${error.remoteError})` : ""}`;

/**
 * The newest compaction marker before the summary starts, read by long-chats.js
 * before it calls `sessions.compact`: null for none, undefined when the read failed.
 */
export function readBaseline(client, sessionKey) {
  return client.call("chat.history", { sessionKey, limit: 20 }).then(
    (history) => latestMarker(history),
    () => undefined,
  );
}

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
 * ran it is gone). `baseline` is the newest marker before the summary started (null
 * for none); when it could not be read (undefined), a marker written since `since`
 * counts. The poll goes on across a reconnect of the same Gateway, and the event
 * connection is opened again once it was lost. Each failing path is logged once per
 * watch, naming `label`. Returns `stop()`, which ends the watch without `onEnd`.
 */
export function watchCompactEnd({
  client,
  sessionKey,
  pollMs,
  alive,
  onEnd,
  baseline,
  since,
  label,
}) {
  let stopped = false;
  let watcher = null;
  let connecting = false;
  const warned = new Set();
  const warnOnce = (what, error) => {
    if (warned.has(what)) return;
    warned.add(what);
    console.warn(`Watching the summary of ${label}: ${what} failed: ${reasonOf(error)}`);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    watcher?.close();
    watcher = null;
  };
  const end = (outcome) => {
    if (stopped) return;
    stop();
    onEnd(outcome);
  };
  const listen = async () => {
    const sibling = client.sibling?.();
    if (!sibling) return;
    connecting = true;
    try {
      await sibling.connect();
      if (stopped) return sibling.close();
      sibling.subscribe((frame) => {
        const outcome = compactEndOf(frame, sessionKey);
        if (outcome) end(outcome);
      });
      // A dropped connection is opened again on the next tick.
      sibling.once?.("disconnected", () => {
        if (watcher === sibling) watcher = null;
      });
      watcher = sibling;
      await sibling.call("sessions.subscribe", {});
    } catch (error) {
      // The marker poll and the request's own answer remain.
      warnOnce("the event connection", error);
      if (watcher === sibling) watcher = null;
      sibling.close();
    } finally {
      connecting = false;
    }
  };
  const read = async () => {
    const marker = latestMarker(
      await client.call("chat.history", { sessionKey, limit: 20 }),
    );
    if (stopped || !marker) return;
    if (baseline === undefined ? marker.at >= since : marker.id !== baseline?.id)
      end("compacted");
  };
  const tick = () => {
    if (!alive()) return end("interrupted");
    if (!watcher && !connecting) listen();
    read().catch((error) => warnOnce("reading the history", error));
  };
  const timer = setInterval(tick, pollMs);
  timer.unref?.();
  tick();
  return stop;
}
