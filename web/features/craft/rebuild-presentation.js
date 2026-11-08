// How a RebuildView reads on the Rebuilds page: status tones, steps, the latest check,
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

/** The latest check: `{ name, passed }` (passed true, false or null), or null. */
export function latestCheck(checks) {
  const check = Array.isArray(checks) ? checks.at(-1) : null;
  if (!check || typeof check !== "object") return null;
  return {
    name: typeof check.name === "string" && check.name ? check.name : null,
    passed: typeof check.passed === "boolean" ? check.passed : null,
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
