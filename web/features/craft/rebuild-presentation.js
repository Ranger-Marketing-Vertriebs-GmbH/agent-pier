// How a RebuildView reads on the Craft Anything page: status tones, steps, the latest check,
// similarity and cost.

export const rebuildSteps = ["study", "build", "check", "ready"];

const tones = {
  starting: "working",
  building: "working",
  checking: "working",
  needs_you: "waiting",
  ready: "ok",
  paused: "idle",
  failed: "error",
};

/** The StatusDot tone of a rebuild's status. */
export const statusTone = (status) => tones[status] ?? "unknown";

/** Each step's state: `done`, `current` or `todo` (all done once ready). */
export function stepStates(step, status) {
  const at = rebuildSteps.indexOf(step);
  return rebuildSteps.map((id, index) => ({
    id,
    state: status === "ready" || index < at ? "done" : index === at ? "current" : "todo",
  }));
}

/** Similarity as whole percent (Craft Anything reports 0–1 or 0–100), or null. */
export function similarityPercent(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(Math.min(100, value <= 1 ? value * 100 : value));
}

// A check's name: Craft Anything 0.6.0 writes it as `check` ("app-screenshot").
const checkName = (check) =>
  [check.name, check.check].find((value) => typeof value === "string" && value) ?? null;

/** The latest check: `{ name, passed }` (passed true, false or null), or null. */
export function latestCheck(checks) {
  const check = Array.isArray(checks) ? checks.at(-1) : null;
  if (!check || typeof check !== "object") return null;
  return {
    name: checkName(check),
    passed: typeof check.passed === "boolean" ? check.passed : null,
  };
}

/**
 * The checks of the latest round (Craft Anything runs several per round, each with
 * its `round`): `{ passed, total }`, as its note says "1 of 2 checks pass".
 */
export function roundChecks(checks) {
  const list = Array.isArray(checks)
    ? checks.filter((check) => check && typeof check === "object")
    : [];
  const round = list.at(-1)?.round;
  // Checks without a round count alone: the latest one.
  const latest =
    round === undefined ? list.slice(-1) : list.filter((check) => check.round === round);
  return {
    passed: latest.filter((check) => check.passed === true).length,
    total: latest.length,
  };
}

/** Newest first, by the last change. */
export const byRecent = (a, b) =>
  String(b.updatedAt || b.createdAt || "").localeCompare(
    String(a.updatedAt || a.createdAt || ""),
  );

/** US dollars in the page's locale ("$0.42"). */
export const usd = (amount, locale) =>
  new Intl.NumberFormat(locale, { style: "currency", currency: "USD" }).format(amount);

/** The clock time of an ISO timestamp in the page's locale ("14:05"). */
export const clockTime = (iso, locale) =>
  new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(iso));
