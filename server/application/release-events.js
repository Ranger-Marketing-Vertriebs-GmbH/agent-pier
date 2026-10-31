import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

// The owner's update pushes: a newer release the automatic update check found (once
// per version, never one a check started by a person already showed), and a release
// that failed to stage, activate or roll back (once per job).
// Neither ever goes to Telegram or a user's device.

const hashed = (value) => createHash("sha256").update(value).digest("hex").slice(0, 40);

/**
 * Records a newer version an update check found; true only the first time. Kept in
 * the observations table, so a later check (or a restart) treats it as known.
 */
function firstSeen(notifications, plan) {
  if (!plan || plan.upToDate || typeof plan.version !== "string") return null;
  const key = `update-available:${plan.version}`;
  if (notifications.observation(key) !== undefined) return null;
  notifications.observe(key, "notified");
  return key;
}

/**
 * After a check someone started: the owner already sees the result, so a newer
 * version is only recorded as known and the automatic check never pushes for it.
 */
export function updateSeen(notifications, plan) {
  firstSeen(notifications, plan);
}

/** After the automatic update check: a newer version notifies once. */
export async function updateAvailable(notifications, plan) {
  const key = firstSeen(notifications, plan);
  if (!key) return;
  await notifications.notify({
    kind: "update-available",
    eventId: `update-${hashed(key)}`,
    label: plan.version,
  });
}

const releaseJobs = new Set(["release-stage", "release-activate", "release-rollback"]);
const failed = new Set(["failed", "interrupted"]);
/** A failure older than this when first seen (an earlier release's) notifies nobody. */
export const releaseFailureWindowMs = 24 * 60 * 60 * 1000;

/**
 * Release jobs that failed: in this process (staging) or in the detached activation
 * helper, whose result this server reads from the job file after it restarted.
 */
export class ReleaseFailureEvents {
  constructor({ dataDir, notifications, now = Date.now, intervalMs = 30000 }) {
    Object.assign(this, { notifications, now, intervalMs });
    this.directory = path.join(dataDir, "operations/jobs");
    this.checkedAt = null;
  }
  failures() {
    let names;
    try {
      names = fs.readdirSync(this.directory);
    } catch {
      return [];
    }
    const jobs = [];
    for (const name of names) {
      if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(this.directory, name), "utf8"));
        if (releaseJobs.has(job.kind) && failed.has(job.status)) jobs.push(job);
      } catch {
        // A job file being written is read on the next pass.
      }
    }
    return jobs;
  }
  /** Checks at most every `intervalMs`; each failed job notifies once, ever. */
  async poll() {
    const now = this.now();
    if (this.checkedAt !== null && now - this.checkedAt < this.intervalMs) return;
    this.checkedAt = now;
    for (const job of this.failures()) {
      const key = `update-failed:${job.id}`;
      if (this.notifications.observation(key) !== undefined) continue;
      this.notifications.observe(key, "notified");
      const finished = Date.parse(job.finishedAt || job.createdAt);
      if (!Number.isFinite(finished) || now - finished > releaseFailureWindowMs) continue;
      await this.notifications.notify({
        kind: "update-failed",
        eventId: `update-failed-${hashed(key)}`,
      });
    }
  }
}
