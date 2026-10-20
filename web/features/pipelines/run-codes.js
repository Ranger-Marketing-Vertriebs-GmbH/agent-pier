import { pipelineCopy as copy } from "../../lib/i18n/messages/pipelines.js";
// Every machine code a pipeline run carries that the UI shows. A unit test checks
// these lists against the codes the engine writes and both catalogs for labels.
export const runCodes = {
  runStatuses: ["running", "awaiting-human", "completed", "failed", "cancelled"],
  nodeStatuses: [
    "pending",
    "running",
    "awaiting-gate",
    "passed",
    "failed",
    "cancelled",
    "skipped",
    // A member of a parallel group whose verdict is in; the group decides.
    "reported",
  ],
  failReasons: [
    "session-error",
    "inactivity-timeout",
    "turn-timeout",
    // Recorded by earlier builds; kept so stored runs still read as text.
    "stage-timeout",
    "pr-failed",
    "usage-limit-exceeded",
    "verdict-missing",
    "verdict-invalid",
    "verdict-fail",
    "verify-failed",
    // Recorded on a resumed repair turn whose session failed; never on a stage.
    "resume-failed",
    "context-exhausted",
    "risk-gate",
    "members-blocked",
    "group-changed-files",
  ],
  attemptKinds: [
    "kickoff",
    "verdict-nudge",
    "gate-feedback",
    "verify-feedback",
    "resumed-repair",
    // A parallel group's own attempt; its members' turns are attempts of their own.
    "group",
  ],
  repairFallbacks: [
    "resume-failed",
    "context-exhausted",
    "profile-changed",
    "no-session",
    "retried",
  ],
  gateDecisions: [
    "accepted",
    "overridden",
    "feedback",
    "looped-back",
    "risk-approved",
    "risk-declined",
  ],
};
// Labels never show a raw code: an unknown code gets a neutral wording.
const label = (labels, code, fallback) =>
  (Object.hasOwn(labels, code) && labels[code]) || fallback;
export const runStatusLabel = (code) => label(copy.statuses, code, copy.unknown);
export const nodeStatusLabel = (code) => label(copy.nodeStatuses, code, copy.unknown);
export const failReasonLabel = (code) =>
  label(copy.failReasons, code, copy.failReasons.unknown);
export const attemptKindLabel = (code) =>
  label(copy.attemptKinds, code, copy.attemptKinds.unknown);
// How the repair turn of a loop back ran: in the stage's earlier session or a new one,
// and why a session that was asked for was not continued.
export function repairSessionLabel(repair) {
  if (!repair) return "";
  const session =
    repair.session === "resumed"
      ? copy.repairSessions.resumed
      : copy.repairSessions.fresh;
  return copy.repairSession(
    session,
    repair.fallback &&
      label(copy.repairFallbacks, repair.fallback, copy.repairFallbacks.unknown),
  );
}
// The session note of a turn in the history: a resumed repair turn's kind already
// says it runs in the same session, so only a new session and its reason are noted.
export const repairNote = (entry) =>
  entry?.repair && entry.kind !== "resumed-repair"
    ? repairSessionLabel(entry.repair)
    : "";
// The tokens a turn reported, or null when it reported none.
export function tokenTotal(usage) {
  if (!usage) return null;
  if (Number.isFinite(usage.totalTokens)) return usage.totalTokens;
  const parts = [usage.inputTokens, usage.outputTokens].filter(Number.isFinite);
  return parts.length ? parts.reduce((sum, n) => sum + n, 0) : null;
}
export const gateDecisionLabel = (code) => label(copy.gateDecisions, code, copy.unknown);
// A run that ended while a stage was still active leaves that stage ended too, even
// when an older run record kept the stage's last live status.
export const effectiveNodeStatus = (run, node) =>
  ["cancelled", "failed"].includes(run.status) &&
  ["running", "awaiting-gate"].includes(node.status)
    ? run.status
    : node.status;
