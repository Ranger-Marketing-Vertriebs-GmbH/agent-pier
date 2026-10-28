// The run counts by status, of all runs and of each project, kept in memory: one full
// scan at start (rebuild), then every saved run (observe) and every deleted one
// (forget). The pills and menu hints read it instead of one full scan per status.
// Each run's list view (run-list-view.js) is kept as a short digest, so a save that changes
// nothing a list shows (an execution log entry) wakes no list.
import { createHash } from "node:crypto";
import { runListView } from "./run-list-view.js";

/** A short digest of `run`'s list view: equal when no listed field changed. */
export const listDigest = (run) =>
  createHash("sha256")
    .update(JSON.stringify(runListView(run)))
    .digest("base64url")
    .slice(0, 22);

// The statuses the run list filters by (GET /api/pipeline-runs?status=).
export const RUN_STATUSES = Object.freeze([
  "running",
  "awaiting-human",
  "completed",
  "failed",
  "cancelled",
]);

const ALL = Symbol("all runs");
const zero = () => Object.fromEntries(RUN_STATUSES.map((status) => [status, 0]));

export class RunCounts {
  constructor() {
    // run id → { projectId, status, listed } as last seen.
    this.runs = new Map();
    // ALL or a project id → { total, counts: status → count }.
    this.totals = new Map();
  }
  /** Replaces the index with a full scan of `runs`. */
  rebuild(runs) {
    this.runs.clear();
    this.totals.clear();
    for (const run of runs) this.observe(run);
  }
  /**
   * Counts `run` as it is now and returns where it was counted before
   * ({projectId, status, listed}: `listed` is its list view's digest), or null for a
   * run new to the index.
   */
  observe(run) {
    if (typeof run?.id !== "string") return null;
    const before = this.forget(run.id);
    const entry = {
      projectId: typeof run.projectId === "string" ? run.projectId : null,
      status: run.status,
      listed: listDigest(run),
    };
    this.runs.set(run.id, entry);
    this.add(entry, 1);
    return before;
  }
  /** The digest of run `id`'s list view as last observed, or null. */
  listed(id) {
    return this.runs.get(id)?.listed ?? null;
  }
  /** Drops the run `id`; returns where it was counted, or null if it was not. */
  forget(id) {
    const entry = this.runs.get(id);
    if (!entry) return null;
    this.runs.delete(id);
    this.add(entry, -1);
    return { ...entry };
  }
  add({ projectId, status }, delta) {
    for (const key of projectId === null ? [ALL] : [ALL, projectId]) {
      if (!this.totals.has(key)) this.totals.set(key, { total: 0, counts: zero() });
      const totals = this.totals.get(key);
      totals.total += delta;
      // A status the list cannot filter by counts in the total only.
      if (RUN_STATUSES.includes(status)) totals.counts[status] += delta;
      if (!totals.total) this.totals.delete(key);
    }
  }
  /** The count of each status, of all runs or of the project `projectId`. */
  counts(projectId) {
    return { ...(this.totals.get(projectId || ALL)?.counts || zero()) };
  }
  /** How many runs there are (any status), of all runs or of `projectId`. */
  total(projectId) {
    return this.totals.get(projectId || ALL)?.total || 0;
  }
}
