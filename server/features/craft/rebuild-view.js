// How a rebuild reads in AgentPier: Craft Anything's status, note, checks, usage and
// questions (rebuild_status + project_show) mapped to the RebuildView.

/** Statuses of a rebuild that may still change without the owner doing anything. */
export const activeStatuses = new Set(["starting", "building", "checking", "needs_you"]);

const statusMap = {
  building: "building",
  running: "building",
  queued: "building",
  starting: "building",
  checking: "checking",
  needs_you: "needs_you",
  waiting: "needs_you",
  ready: "ready",
  done: "ready",
  stopped: "paused",
  paused: "paused",
};

/**
 * AgentPier's status for Craft Anything's `status` (0.5.0 reports `building`,
 * `needs_you`, `ready` and `stopped`, labelled "Paused"). Failures map to `failed`;
 * an unknown status reads `building` while the build runs, else `paused`.
 */
export function rebuildStatus(craftStatus, running) {
  const status = typeof craftStatus === "string" ? craftStatus.toLowerCase() : "";
  if (Object.hasOwn(statusMap, status)) return statusMap[status];
  if (/fail|error|crash/.test(status)) return "failed";
  return running ? "building" : "paused";
}

/** The step (study → build → check → ready) a status and Craft Anything's note show. */
export function rebuildStep(status, note) {
  if (status === "ready") return "ready";
  if (status === "checking") return "check";
  if (status === "starting") return "study";
  const text = typeof note === "string" ? note.toLowerCase() : "";
  if (/\b(check|compar|verif)/.test(text)) return "check";
  if (/\b(stud|investigat|captur|explor|analy|read|inspect)/.test(text)) return "study";
  return "build";
}

const text = (value) => (typeof value === "string" ? value : null);
const count = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

function similarityOf(check) {
  const value = check?.similarity ?? check?.score;
  return Number.isFinite(value) ? value : null;
}

function question(item) {
  return {
    id: String(item.id),
    kind: item.kind === "approval" ? "approval" : "question",
    title: text(item.title) ?? "",
    detail: text(item.detail) ?? "",
    choices: Array.isArray(item.choices) ? item.choices.filter((c) => text(c)) : [],
    allowText: item.allow_text === true,
    action: text(item.action),
  };
}

/** The record fields one sample of `rebuild_status` and `project_show` gives. */
export function sampledFields(status, show) {
  const running = Boolean(status?.running || status?.queued);
  const state = rebuildStatus(status?.status ?? show?.status, running);
  const note = text(status?.note) ?? text(show?.note);
  const checks = Array.isArray(show?.checks) ? show.checks : [];
  const usage = show?.usage ?? {};
  return {
    running,
    status: state,
    statusLabel: text(status?.status_label),
    note,
    step: rebuildStep(state, note),
    checks,
    similarity: similarityOf(status?.last_check) ?? similarityOf(checks.at(-1)),
    usage: {
      inputTokens: count(usage.input_tokens),
      outputTokens: count(usage.output_tokens),
      costUsd: count(usage.cost_usd),
    },
    lastReply: text(show?.last_reply),
    questions: Array.isArray(show?.questions)
      ? show.questions.filter((item) => item && item.id != null).map(question)
      : [],
  };
}

/** A new rebuild's record fields before Craft Anything reported anything. */
export const initialFields = () => ({
  running: true,
  status: "starting",
  statusLabel: null,
  note: null,
  step: "study",
  checks: [],
  similarity: null,
  usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
  lastReply: null,
  questions: [],
});

const viewKeys = [
  "id",
  "projectId",
  "folder",
  "name",
  "request",
  "target",
  "stack",
  "rounds",
  "accountId",
  "mode",
  "autoMode",
  "source",
  "createdAt",
  "updatedAt",
  "status",
  "statusLabel",
  "note",
  "step",
  "checks",
  "similarity",
  "usage",
  "lastReply",
  "questions",
];

/** The RebuildView of a stored record (a copy). */
export function rebuildView(record) {
  return structuredClone(Object.fromEntries(viewKeys.map((key) => [key, record[key]])));
}

/** Whether the owner would see a difference between two records. */
export const viewChanged = (before, after) =>
  JSON.stringify(rebuildView(before)) !== JSON.stringify(rebuildView(after));
