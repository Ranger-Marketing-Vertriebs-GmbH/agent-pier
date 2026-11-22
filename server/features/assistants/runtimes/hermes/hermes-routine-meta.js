import fs from "node:fs";
import path from "node:path";
import { writePrivate } from "../../../../lib/storage.js";
import { metaField } from "./hermes-routine-jobs.js";

// AgentPier's part of each routine of one Hermes agent (hermes-routine-jobs.js
// routineMeta: the marker, the agent, target, delivery, the prompt's run settings, the
// time zone and a revision), by Hermes job id, in `agentpier-routines.json` beside the
// agent's HERMES_HOME files, where the run deliveries live too (hermes-routines.js).
// Hermes v0.22.5 kept it in the job's own `agentpier` field; since v0.23 the cron
// REST routes refuse to update any field of their own list
// (hermes_cli/web_routers/cron.py _normalize_dashboard_cron_updates), so AgentPier
// keeps it here. A job written for v0.22.5 still carries its field, which counts until
// this store names the job: so an update reads jobs of either release, and a rollback
// to v0.22.5 reads the routines written since from this store as well.

const stores = new WeakMap();

export class HermesRoutineMeta {
  constructor(file = null) {
    this.file = file;
    this.memory = {};
  }
  /**
   * The saved meta by job id. A file that is not a JSON object is never written
   * over: it is set aside as `<file>.corrupt-<time>` for the owner and reported, and
   * the store starts empty (a job written for v0.22.5 still reads its own field).
   */
  records() {
    if (!this.file) return this.memory;
    let text;
    try {
      text = fs.readFileSync(this.file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return {};
      throw error;
    }
    try {
      const saved = JSON.parse(text);
      if (saved && typeof saved === "object" && !Array.isArray(saved)) return saved;
    } catch {
      /* Set aside below. */
    }
    fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
    console.error(
      "AgentPier set aside an unreadable Hermes routine store: HERMES_ROUTINE_META_UNREADABLE",
    );
    return {};
  }
  save(records) {
    if (!this.file) this.memory = records;
    else writePrivate(this.file, records);
  }
  /** The meta of job `id`, or undefined. */
  get(id) {
    const meta = typeof id === "string" ? this.records()[id] : undefined;
    return meta && typeof meta === "object" ? meta : undefined;
  }
  set(id, meta) {
    this.save({ ...this.records(), [id]: meta });
  }
  delete(id) {
    const records = this.records();
    if (!(id in records)) return;
    delete records[id];
    this.save(records);
  }
  /** The job ids it holds meta for. */
  ids() {
    return Object.keys(this.records());
  }
  /** Drops the meta of jobs that are gone (`gone`: their ids). */
  prune(gone) {
    const records = this.records();
    gone = gone.filter((id) => id in records);
    if (!gone.length) return;
    for (const id of gone) delete records[id];
    this.save(records);
  }
  /** `job` with AgentPier's part in its `agentpier` field, as routineOfJob reads it. */
  attach(job) {
    if (!job || typeof job !== "object") return job;
    const meta = this.get(job.id) ?? job[metaField];
    return meta === undefined ? job : { ...job, [metaField]: meta };
  }
}

/**
 * The routine meta of one agent's process set, kept beside its HERMES_HOME. An agent
 * whose folders cannot be named throws (no meta that would vanish with the process);
 * a home that does not exist (a test double's) keeps it in memory.
 */
export function routineMetaOf(supervisor) {
  if (stores.has(supervisor)) return stores.get(supervisor);
  const home = supervisor.agentPaths().hermesHome;
  const file = fs.existsSync(home) ? path.join(home, "agentpier-routines.json") : null;
  const store = new HermesRoutineMeta(file);
  stores.set(supervisor, store);
  return store;
}
