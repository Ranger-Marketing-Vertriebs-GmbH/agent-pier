// The run counts by status, of all runs and of each project, kept in memory: one full
// scan at start (rebuild), then every saved run (observe) and every deleted one
// (forget). The pills and menu hints read it instead of one full scan per status.

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
    // run id → { projectId, status } as last seen.
    this.runs = new Map();
    // ALL or a project id → status → count.
    this.totals = new Map();
  }
  /** Replaces the index with a full scan of `runs`. */
  rebuild(runs) {
    this.runs.clear();
    this.totals.clear();
    for (const run of runs) this.observe(run);
  }
  /**
   * Counts `run` ({id, projectId, status}) as it is now and returns where it was
   * counted before ({projectId, status}), or null for a run new to the index.
   */
  observe(run) {
    if (typeof run?.id !== "string") return null;
    const before = this.forget(run.id);
    const entry = {
      projectId: typeof run.projectId === "string" ? run.projectId : null,
      status: run.status,
    };
    this.runs.set(run.id, entry);
    this.add(entry, 1);
    return before;
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
    if (!RUN_STATUSES.includes(status)) return;
    for (const key of projectId === null ? [ALL] : [ALL, projectId]) {
      if (!this.totals.has(key)) this.totals.set(key, zero());
      const counts = this.totals.get(key);
      counts[status] += delta;
      if (delta < 0 && Object.values(counts).every((count) => count === 0))
        this.totals.delete(key);
    }
  }
  /** The count of each status, of all runs or of the project `projectId`. */
  counts(projectId) {
    return { ...(this.totals.get(projectId ? projectId : ALL) || zero()) };
  }
}
