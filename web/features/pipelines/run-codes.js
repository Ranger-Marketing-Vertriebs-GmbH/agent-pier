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
  ],
  attemptKinds: ["kickoff", "verdict-nudge", "gate-feedback", "verify-feedback"],
  gateDecisions: ["accepted", "overridden", "feedback", "looped-back"],
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
export const gateDecisionLabel = (code) => label(copy.gateDecisions, code, copy.unknown);
// A run that ended while a stage was still active leaves that stage ended too, even
// when an older run record kept the stage's last live status.
export const effectiveNodeStatus = (run, node) =>
  ["cancelled", "failed"].includes(run.status) &&
  ["running", "awaiting-gate"].includes(node.status)
    ? run.status
    : node.status;
