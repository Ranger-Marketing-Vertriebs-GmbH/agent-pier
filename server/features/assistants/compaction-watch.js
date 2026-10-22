// How a summary on request (long-chats.js) ends. OpenClaw 2026.10.3
// (sessions-compact) runs it inside runExclusiveSessionLifecycleMutation("compact")
// and holds the session's lifecycle lock until it committed; chat.send meanwhile
// waits for it. Its end, success or not, is the `sessions.compact` answer, so
// long-chats.js keeps that call open up to its bound. 2026.10.3 exposes no per-session
// lifecycle state to a read-only call (sessions.describe and chat.history show no
// running operation; health counts mutations of the whole Gateway), and its
// `session.operation` events reach only connections that subscribed to every
// session's changes. So after a dropped call, with the same Gateway still running,
// the only read-only evidence is a new compaction marker in chat.history
// (`__openclaw.kind: "compaction"`, conversations.js): it shows a success. A summary
// that ends otherwise leaves none, so that watch is bounded (lostMs, long-chats.js).

// What a failed step logs: its code and the Gateway's error class, never its text
// (it may name host paths).
export const reasonOf = (error) =>
  `${error?.code || "unknown"}${error?.remoteError ? ` (${error.remoteError})` : ""}`;

// The Gateway's refusal of a session that is working; its other answers are failures.
const working = (error) =>
  error?.code === "INVALID_REQUEST" &&
  /active run|queued work/.test(error.remoteMessage || "");

/**
 * The one outcome of a `sessions.compact` answer or failure: "compacted", "nothing"
 * (answered without summarising), "busy" (refused: the session has work), "failed"
 * (any other Gateway answer), "unknown" (no answer within the bound), "lost" (the
 * connection dropped while the call was out) or "interrupted" (no Gateway to ask).
 */
export function compactOutcome({ result, error } = {}) {
  if (!error) return result?.compacted === true ? "compacted" : "nothing";
  if (working(error)) return "busy";
  if (error.answered) return "failed";
  if (error.code === "TIMEOUT") return "unknown";
  if (error.code === "CLOSED") return "lost";
  return "interrupted";
}

/** The newest compaction marker of a chat.history page: { id, at } or null. */
export function latestMarker(history) {
  const m = (Array.isArray(history?.messages) ? history.messages : [])
    .filter((m) => m?.__openclaw?.kind === "compaction" && m.__openclaw.id)
    .at(-1);
  return m ? { id: String(m.__openclaw.id), at: Number(m.timestamp) || 0 } : null;
}

const readMarker = async (client, sessionKey) =>
  latestMarker(await client.call("chat.history", { sessionKey, limit: 20 }));

/**
 * The newest marker before the summary starts: null for none, undefined when the
 * read failed (logged through `warn`).
 */
export function readBaseline(client, sessionKey, warn) {
  return readMarker(client, sessionKey).catch((error) => {
    warn("reading the history before it", error);
    return undefined;
  });
}

/**
 * Polls the history every `pollMs` for a marker newer than `baseline` (or, without
 * one, written since `since`) and calls `onEnd("compacted")`; `onEnd("interrupted")`
 * once `alive()` is false. A failing read is passed to `warn`. Returns `stop()`.
 */
export function watchMarker({
  client,
  sessionKey,
  pollMs,
  baseline,
  since,
  alive,
  onEnd,
  warn,
}) {
  let stopped = false;
  const end = (outcome) => {
    if (stopped) return;
    stop();
    onEnd(outcome);
  };
  const tick = async () => {
    if (stopped) return;
    if (!alive()) return end("interrupted");
    const marker = await readMarker(client, sessionKey);
    if (stopped || !marker) return;
    if (baseline === undefined ? marker.at >= since : marker.id !== baseline?.id)
      end("compacted");
  };
  const run = () => tick().catch((error) => warn("reading the history", error));
  const timer = setInterval(run, pollMs);
  timer.unref?.();
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  run();
  return stop;
}
