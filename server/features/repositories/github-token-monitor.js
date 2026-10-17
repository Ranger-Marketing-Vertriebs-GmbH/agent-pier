import { createHash } from "node:crypto";

export const dayMs = 24 * 60 * 60 * 1000;
// States that need the owner: GitHub rejects the token, or soon will.
export const attentionStates = new Set(["invalid", "expired", "expiring"]);

/**
 * Checks every saved GitHub token about once a day and notifies the owner when a
 * token turns invalid, expires or is about to expire. Each result is stored on its
 * profile, so the list shows it and a restart does not repeat a recent check.
 */
export class GithubTokenMonitor {
  constructor({
    repositories,
    notifications,
    intervalMs = 60 * 60 * 1000,
    initialDelayMs = 2 * 60 * 1000,
    maxAgeMs = dayMs,
    now = Date.now,
    onError = () => {},
  }) {
    Object.assign(this, {
      repositories,
      notifications,
      intervalMs,
      initialDelayMs,
      maxAgeMs,
      now,
      onError,
    });
    this.pending = null;
    this.closed = false;
  }
  start() {
    if (this.closed || this.timer) return;
    const tick = () => this.run().catch(this.onError);
    this.timer = setTimeout(() => {
      tick();
      this.timer = setInterval(tick, this.intervalMs);
      this.timer.unref?.();
    }, this.initialDelayMs);
    this.timer.unref?.();
  }
  run() {
    if (this.closed) return Promise.resolve();
    this.pending ??= this.collect().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }
  async collect() {
    for (const credential of this.repositories.listCredentials()) {
      if (this.closed) return;
      const last = Date.parse(credential.tokenCheck?.checkedAt || "");
      if (Number.isFinite(last) && this.now() - last < this.maxAgeMs) continue;
      let checked;
      try {
        checked = await this.repositories.checkCredential(credential.id);
      } catch (error) {
        this.onError(error);
        continue;
      }
      const state = checked?.tokenCheck?.state;
      if (!attentionStates.has(state) || credential.tokenCheck?.state === state) continue;
      // One notice per profile and state change; a repeated run reuses the event id.
      const eventId = createHash("sha256")
        .update(`github-token:${credential.id}:${state}:${checked.tokenCheck.checkedAt}`)
        .digest("hex")
        .slice(0, 64);
      await this.notifications
        ?.notify({ kind: "github-token", eventId })
        .catch(this.onError);
    }
  }
  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.timer);
    await this.pending?.catch(() => {});
  }
}
