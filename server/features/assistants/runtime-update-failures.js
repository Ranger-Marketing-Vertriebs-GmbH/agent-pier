// What a failed staging or activation records for the owner and the log: stable
// codes, steps and check names, never a message, a path or a secret
// (runtime-updates.js).
const stableCode = (code) =>
  typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : null;
/**
 * Why staging failed, for the owner and the log: the failure's most specific stable
 * code and the HTTP status of a download the server refused. Most specific first:
 * the original code an installer kept beside its own (`diagnosticCode`, as
 * hermes-install.js keeps ENOSPC under HERMES_INSTALL_FAILED), the cause's (a failed
 * fetch carries ECONNRESET there), then the failure's own. Never a message: it may
 * hold paths or URLs.
 */
export function stageCause(error) {
  const code =
    stableCode(error?.diagnosticCode) ||
    stableCode(error?.cause?.code) ||
    stableCode(error?.code);
  const status = error?.upstreamStatus;
  const upstreamStatus =
    Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
  return code || upstreamStatus ? { code, upstreamStatus } : null;
}
// The steps of an activation after the stop, as the journal names the one that failed.
const activationSteps = new Set([
  "stop",
  "snapshot",
  "migrate",
  "start",
  "validate",
  "verify",
]);
// A validation check (runtime-update-validation.js): "host", "routines", "roster",
// "roster:<runtimeAgentId>", "session:<conversationId>" or "blockers".
const checkTag = /^(host|routines|roster|blockers|(roster|session):[A-Za-z0-9_-]{1,64})$/;
const errorTag = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
/**
 * Where an activation failed, for the journal of the rollback that follows: its step,
 * and for a validation the check that failed and the runtime's code. Only names that
 * pass these patterns: never a message, a path or a secret.
 */
export function activationFailure(step, error) {
  const tag = (value, pattern) =>
    typeof value === "string" && pattern.test(value) ? value : null;
  return {
    diagnosticStep: activationSteps.has(step) ? step : null,
    diagnosticCheck: tag(error?.check, checkTag),
    diagnosticErrorCode: tag(error?.errorCode, errorTag) || tag(error?.code, errorTag),
  };
}
export const clearedFailure = {
  diagnosticStep: null,
  diagnosticCheck: null,
  diagnosticErrorCode: null,
};
// The phases that show where the activation failed: its rollback and after.
export const failurePhases = new Set([
  "rolling_back",
  "rollback_committed",
  "rolled_back",
  "recovery_required",
]);
