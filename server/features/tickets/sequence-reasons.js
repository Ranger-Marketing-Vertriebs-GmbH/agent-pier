// Why a sequence item waits for the owner (`needsOwner.reason`). The single list the
// web copy (de/en) is checked against.
export const PARK_REASONS = Object.freeze([
  "githubRequired",
  "sourceUnavailable",
  "ticketUnavailable",
  "startFailed",
  "startInterrupted",
  "taskNotDelivered",
  "sessionEnded",
  "runFailed",
  "noPullRequest",
  "prClosed",
  "mergeDisarmed",
  "armRefused",
  "mergeRefused",
  // Task 9: fix attempts and owner limits.
  "idle",
  "failedRounds",
  "forgeUnreachable",
  "repairUnconfigured",
]);

const TRANSIENT_CODES = new Set(["unavailable", "unreachable", "rateLimited"]);

/**
 * True for a failure that may pass on its own: an unreachable or overloaded forge, a
 * rate limit, an aborted request or a server-side 5xx without a source code.
 */
export function isTransient(error) {
  if (error?.name === "AbortError") return true;
  if (typeof error?.code === "string") return TRANSIENT_CODES.has(error.code);
  return Number.isInteger(error?.status) && error.status >= 500;
}
