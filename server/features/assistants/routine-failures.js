import { redactSecrets, redactedMark } from "../../lib/secret-redaction.js";

// Why a routine's (or reminder's) native run failed, from what OpenClaw records for
// it (2026.10.7): a cron run entry's `error` and `errorReason`, or the job's
// `state.lastError` and `state.lastErrorReason` (the failover reason: auth, billing,
// rate_limit, overloaded, timeout, model_not_found, server_error, …). `reason` is a
// stable identifier the settings and the chat translate; `message` is OpenClaw's own
// text for the details, secrets redacted and at most `failureMessageLimit` long. The
// owner and the agent see both; native error text keeps its original language.
export const failureMessageLimit = 500;
export const failureReasons = [
  "gateway-restart",
  "gateway-stopped",
  "agent-unavailable",
  "timeout",
  "model",
  "delivery",
  "other",
];
// OpenClaw's failover reasons that name the model provider (failover-error).
const modelReasons = new Set([
  "auth",
  "auth_permanent",
  "billing",
  "rate_limit",
  "overloaded",
  "model_not_found",
  "server_error",
  "format",
  "context_overflow",
  "session_expired",
]);
// Causes outside the model, by OpenClaw's own message; they win over its failover
// reason ("cron: job interrupted by gateway restart", "… because owner is
// unavailable" when the Gateway went away, an agent missing from the configuration).
const outside = [
  // Also a run started while a restarted Gateway still settles its cron receipts.
  [
    "gateway-restart",
    /interrupted by gateway restart|did not drain before shutdown|receipt authority is unavailable/i,
  ],
  [
    "gateway-stopped",
    /owner (?:is )?unavailable|gateway (?:is )?(?:not running|stopped|closed|shut ?down|unavailable)/i,
  ],
  [
    "agent-unavailable",
    /unknown agent ?id|no longer exists in configuration|agent\b[^\n]{0,40}\b(?:unavailable|degraded|not found|disabled)/i,
  ],
];
// Without a failover reason: the message's own words, in this order.
const worded = [
  ["timeout", /timed out|timeout|stalled before execution start|etimedout/i],
  ["delivery", /\bdeliver(?:y|ed|ing)?\b/i],
  [
    "model",
    /\b(?:401|403|429|5\d\d)\b|rate[ _-]?limit|overloaded|too many requests|quota|billing|insufficient[ _]credit|invalid[ _]api[ _]key|unauthori[sz]ed|provider|ai service|model\b/i,
  ],
];
const match = (rules, text) => rules.find(([, pattern]) => pattern.test(text))?.[0];
// Context secrets the shell rules of secret-redaction.js do not name: URL query
// values and bare bearer tokens in an HTTP error text.
const queryValue =
  /([?&](?:token|key|api[_-]?key|apikey|access[_-]?token|auth|secret|password|sig|signature)=)[^&\s"'#]+/giu;
const bearer = /(\bbearer[ \t]+)[A-Za-z0-9._~+/=-]{8,}/giu;
const control = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** OpenClaw's error text, readable and safe to show: redacted, at most the limit. */
export function failureMessage(text, limit = failureMessageLimit) {
  if (typeof text !== "string") return "";
  const safe = redactSecrets(text.slice(0, 8 * limit).replace(control, " "))
    .replace(queryValue, `$1${redactedMark}`)
    .replace(bearer, `$1${redactedMark}`)
    .trim();
  const points = Array.from(safe);
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : safe;
}

/** The cause of one failed run, or null when it did not fail. */
export function runFailure({ status, error, errorReason } = {}) {
  if (status !== "error") return null;
  const text = typeof error === "string" ? error : "";
  const reason =
    match(outside, text) ||
    (errorReason === "timeout" ? "timeout" : null) ||
    (modelReasons.has(errorReason) ? "model" : null) ||
    match(worded, text) ||
    "other";
  const message = failureMessage(text);
  return { reason, ...(message ? { message } : {}) };
}

/** A job's last failed run (cron.list state), with how many failed in a row. */
export function lastRunFailure(state) {
  const failure = runFailure({
    status: state?.lastRunStatus ?? state?.lastStatus,
    error: state?.lastError,
    errorReason: state?.lastErrorReason,
  });
  if (!failure) return null;
  return {
    ...failure,
    ...(Number.isSafeInteger(state.lastRunAtMs) ? { atMs: state.lastRunAtMs } : {}),
    ...(Number.isSafeInteger(state.consecutiveErrors) && state.consecutiveErrors > 0
      ? { consecutive: state.consecutiveErrors }
      : {}),
  };
}

/** One cron.runs entry as the run history shows it, with its failure's cause. */
export function runEntry(r) {
  const failure = runFailure(r);
  return {
    runAtMs: r.runAtMs,
    status: r.status,
    completionStatus: r.completionStatus,
    deliveryStatus: r.deliveryStatus,
    ...(Number.isFinite(r.durationMs) ? { durationMs: r.durationMs } : {}),
    ...(failure ? { failure } : {}),
  };
}
