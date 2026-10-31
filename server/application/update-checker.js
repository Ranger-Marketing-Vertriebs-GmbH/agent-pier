import { updateAvailable } from "./release-events.js";

// The automatic update check: once a few minutes after the server started, then once a
// day, on the owner's selected channel. It only checks (the same check as **Check for
// updates**, which also refreshes the menu's update hint); it never stages or
// activates anything. Only this check pushes: a newer version notifies once, and never
// one a check started by a person already found (release-events.js). Two requests
// a day stay far below GitHub's unauthenticated rate limit for the preview channel.

export const startDelayMs = 3 * 60 * 1000;
export const intervalMs = 24 * 60 * 60 * 1000;
/** Each run is moved by up to this much, so installations do not check in lockstep. */
export const jitterMs = 30 * 60 * 1000;

export class UpdateChecker {
  constructor({
    releases,
    notifications,
    logger = console,
    random = Math.random,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    delays = { startDelayMs, intervalMs, jitterMs },
  }) {
    Object.assign(this, {
      releases,
      notifications,
      logger,
      random,
      setTimer,
      clearTimer,
    });
    this.delays = delays;
    this.timer = null;
    this.failing = false;
    this.closed = false;
    this.running = null;
  }
  start() {
    if (this.closed || this.timer) return;
    this.schedule(this.delays.startDelayMs);
  }
  schedule(base) {
    if (this.closed) return;
    const delay = base + Math.floor(this.random() * this.delays.jitterMs);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.running = this.run().finally(() => {
        this.running = null;
        this.schedule(this.delays.intervalMs);
      });
    }, delay);
    this.timer?.unref?.();
  }
  /** One check; a failure (offline, no channel) is logged once per streak, never pushed. */
  async run() {
    // Without a channel there is nothing to check; that is no failure.
    if (!this.releases.channel) return null;
    let plan;
    try {
      plan = await this.releases.check();
    } catch (error) {
      if (!this.failing)
        this.logger.warn?.(
          `AgentPier could not check for updates; it tries again in a day: ${error?.code || error?.status || "unknown error"}`,
        );
      this.failing = true;
      return null;
    }
    this.failing = false;
    if (!this.closed) await updateAvailable(this.notifications, plan).catch(() => {});
    return plan;
  }
  async close() {
    this.closed = true;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    await this.running;
  }
}
