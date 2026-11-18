/**
 * The technical detail of why staging an agent runtime update failed: the server's
 * `{ code, upstreamStatus }` (runtime-updates.js stageCause) as "ECONNRESET" or
 * "HTTP 429", both joined by " · "; "" without a usable cause. Codes stay as the
 * server reports them: they are diagnostic evidence, not product copy.
 */
export function updateCauseDetail(cause) {
  if (!cause || typeof cause !== "object") return "";
  const code =
    typeof cause.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(cause.code)
      ? cause.code
      : null;
  const status = Number.isInteger(cause.upstreamStatus) ? cause.upstreamStatus : null;
  return [code, status && `HTTP ${status}`].filter(Boolean).join(" · ");
}

const failedSteps = new Set([
  "stop",
  "snapshot",
  "migrate",
  "start",
  "validate",
  "verify",
]);
const failureTag = /^[A-Za-z][A-Za-z0-9_.:-]{0,128}$/;
/**
 * Where a rolled-back activation failed, from the server's status
 * (runtime-updates.js activationFailure): `{ step, detail }`, `step` one of the
 * activation steps and `detail` its check and code joined by " · " (such as
 * "session:c1 · agent-database-inspection-failed"), or null without a known step.
 * Check and code stay as the server reports them: diagnostic evidence, not copy.
 */
export function updateFailure(status) {
  const step = status?.diagnosticStep;
  if (typeof step !== "string" || !failedSteps.has(step)) return null;
  const detail = [status.diagnosticCheck, status.diagnosticErrorCode]
    .filter((value) => typeof value === "string" && failureTag.test(value))
    .join(" · ");
  return { step, detail };
}
