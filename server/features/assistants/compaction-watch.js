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

// What a failed step logs. A Gateway failure: its code and error class, never its
// text (it may name host paths). A local error without a code (a bug in AgentPier):
// its class, message and first stack line.
export function reasonOf(error) {
  if (error?.code)
    return `${error.code}${error.remoteError ? ` (${error.remoteError})` : ""}`;
  if (!(error instanceof Error)) return "unknown";
  const at = error.stack
    ?.split("\n")
    .find((line) => /^\s+at /.test(line))
    ?.trim();
  return `${error.name}: ${error.message}${at ? ` (${at})` : ""}`;
}
/** The key under which a failure is logged once: its code, else its class. */
export const kindOf = (error) =>
  String(error?.code || (error instanceof Error ? error.name : "unknown"));

// The Gateway's refusal of a session that is working; its other answers are failures.
const working = (error) =>
  error?.code === "INVALID_REQUEST" &&
  /active run|queued work/.test(error.remoteMessage || "");

// OpenClaw's own "nothing to do" reasons (resource-loader
// preflightManualSessionCompaction), which sessions-compact answers as `ok: false`.
const noop = /^(already compacted|nothing to compact)/i;
// An active run, as the call answers it: sessions-compact forwards only ok, key,
// compacted, reason and result, so embedded-agent's `failure: {reason: "active_run"}`
// arrives as its MANUAL_COMPACTION_ACTIVE_RUN_REASON text alone.
const activeRun = /^manual compaction unavailable while another embedded run is active/i;

/**
 * A short code for an answered `ok: false`, safe to log: "nothing", "active_run",
 * the embedded `failure.reason` should a later Gateway forward it, or "ok_false".
 */
export function answerCodeOf(result) {
  const reason = String(result?.reason ?? "");
  if (noop.test(reason)) return "nothing";
  if (result?.failure?.reason === "active_run" || activeRun.test(reason))
    return "active_run";
  return /^[a-z_]{1,60}$/.test(result?.failure?.reason ?? "")
    ? result.failure.reason
    : "ok_false";
}

/**
 * The one outcome of a `sessions.compact` answer or failure. OpenClaw 2026.10.3
 * (re-verified on 2026.10.7) answers a summary that failed as a successful call:
 * `{ok: false, compacted: false, reason}` (provider or auth errors, aborts,
 * context-engine failures, embedded-agent),
 * an active run with its "manual compaction unavailable while another embedded run
 * is active" reason (the `failure` it carries inside does not reach the call), and
 * nothing to do as
 * `ok: true, compacted: false` or, from its preflight, `ok: false` with an
 * "Already compacted" or "Nothing to compact" reason. Outcomes: "compacted",
 * "nothing", "busy" (refused: the session has work), "failed" (any other Gateway
 * answer), "unknown" (no answer within the bound), "lost" (the connection dropped
 * while the call was out) or "interrupted" (no Gateway to ask).
 */
export function compactOutcome({ result, error } = {}) {
  if (!error) {
    if (result?.compacted === true) return "compacted";
    if (result?.ok !== false) return "nothing";
    const code = answerCodeOf(result);
    return code === "nothing" ? "nothing" : code === "active_run" ? "busy" : "failed";
  }
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
