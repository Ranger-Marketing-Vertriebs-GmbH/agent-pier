import { createHash } from "node:crypto";

// Below 10 % free the start page warns; the warning clears again at 12 % so a disk
// hovering around the threshold neither flickers nor repeats the push notice.
export const WARN_BELOW_PERCENT = 10;
export const RECOVER_AT_PERCENT = 12;
const OBSERVATION = "system-status:disk";

export function freePercent(disk) {
  if (!disk || !(disk.totalBytes > 0)) return null;
  return Math.round((disk.freeBytes / disk.totalBytes) * 1000) / 10;
}

/** The next warning state for a free share; an unknown share keeps the current one. */
export function nextDiskWarning(active, percent) {
  if (percent === null || !Number.isFinite(percent)) return active;
  return active ? percent < RECOVER_AT_PERCENT : percent < WARN_BELOW_PERCENT;
}

/**
 * Tracks low disk space and sends one push notice per episode. The state persists in
 * the notification store, so a restart during a low episode does not notify again.
 */
export class DiskWarning {
  constructor({ notifications, now = Date.now, onError = () => {} }) {
    Object.assign(this, { notifications, now, onError });
    let stored;
    try {
      stored = JSON.parse(notifications?.observation(OBSERVATION) || "null");
    } catch {
      stored = null;
    }
    this.active = stored?.state === "low";
    this.since = stored?.since || null;
  }
  update(disk) {
    const active = nextDiskWarning(this.active, freePercent(disk));
    if (active === this.active) return active;
    this.active = active;
    this.since = active ? new Date(this.now()).toISOString() : null;
    try {
      this.notifications?.observe(
        OBSERVATION,
        JSON.stringify({ state: active ? "low" : "ok", since: this.since }),
      );
    } catch (error) {
      this.onError(error);
    }
    if (active) {
      const eventId = createHash("sha256")
        .update(`disk-space:${this.since}`)
        .digest("hex")
        .slice(0, 64);
      Promise.resolve(this.notifications?.notify({ kind: "disk-space", eventId })).catch(
        this.onError,
      );
    }
    return active;
  }
}
