import { CdpInput, inputCalls, validateInput } from "./browser-input.js";
import {
  historyCalls,
  historyStep,
  validateNavigation,
  validateTab,
} from "./browser-navigation.js";

// Without owner input for this long the browser goes back to the agent; a minute
// before, the owner is warned. A holder whose every view closed gets a short grace
// to come back (a reload, a dropped phone connection).
export const leaseMs = 10 * 60 * 1000;
export const warnMs = 60 * 1000;
export const graceMs = 30 * 1000;
const problem = (code) => Object.assign(Error(code), { code });

/**
 * The owner's control lease on one agent's browser (docs/assistant-gateway.md
 * "Takeover"). One holder at a time: a login session of the owner. While it holds
 * the lease the tool guard refuses the agent's browser calls (AgentBrowsers.policy),
 * and the owner's input goes to the shown tab over the agent's own CDP port. The
 * lease ends on hand-back, after `leaseMs` without input, or when the holder's views
 * stay closed for `graceMs`; `onHandBack(id, reason)` then lets the agent continue.
 */
export class Takeover {
  constructor(stream) {
    this.stream = stream;
    this.live = stream.live;
    this.holder = null;
    this.lastInput = 0;
    this.warning = false;
    this.timer = null;
    this.grace = null;
    this.channel = null;
    // Whether the agent tried the browser during this lease and was refused.
    this.refused = false;
  }
  snapshot() {
    return this.holder
      ? {
          holder: this.holder,
          warning: this.warning,
          expiresAt: this.lastInput + this.live.leaseMs,
        }
      : null;
  }
  /** Takes the lease; `move` takes it from the owner's other device. */
  take(holder, { move = false } = {}) {
    if (this.holder && this.holder !== holder && !move) throw problem("LEASE_HELD");
    if (this.holder !== holder) {
      // The other device's input channel stops here.
      this.channel?.close();
      this.channel = null;
    }
    if (!this.holder) this.refused = false;
    this.holder = holder;
    this.touch();
    clearTimeout(this.grace);
    this.grace = null;
    clearInterval(this.timer);
    this.timer = setInterval(() => this.check(), 5000);
    this.timer.unref?.();
    this.stream.set({});
  }
  touch() {
    this.lastInput = this.live.now();
    if (this.warning) {
      this.warning = false;
      this.stream.set({});
    }
  }
  /** Ends the lease when idle for too long; warns a minute before. */
  check() {
    if (!this.holder) return;
    const idle = this.live.now() - this.lastInput;
    if (idle >= this.live.leaseMs) return this.release("timeout");
    if (idle >= this.live.leaseMs - this.live.warnMs && !this.warning) {
      this.warning = true;
      this.stream.set({});
    }
  }
  handBack(holder) {
    if (!this.holder || holder !== this.holder) return false;
    this.release("owner");
    return true;
  }
  release(reason) {
    if (!this.holder) return;
    this.holder = null;
    this.warning = false;
    clearInterval(this.timer);
    clearTimeout(this.grace);
    this.timer = this.grace = null;
    this.channel?.close();
    this.channel = null;
    this.stream.set({});
    // The agent hears about it only when it was kept waiting; a shutdown never.
    const waited = this.refused;
    this.refused = false;
    if (waited && reason !== "stopped") this.live.onHandBack?.(this.stream.id, reason);
    if (!this.stream.viewers.size && reason !== "stopped") this.live.drop(this.stream);
  }
  /** The holder's views all closed: the lease waits `graceMs` for one to return. */
  viewsChanged(holders) {
    if (!this.holder) return;
    if (holders.has(this.holder)) {
      clearTimeout(this.grace);
      this.grace = null;
    } else if (!this.grace) {
      this.grace = setTimeout(() => this.release("left"), this.live.graceMs);
      this.grace.unref?.();
    }
  }
  /** One input command of the holder, to the tab the view shows. */
  async input(holder, command) {
    this.require(holder);
    const valid = validateInput(command);
    if (!valid) throw problem("INVALID_INPUT");
    this.touch();
    const { channel, targetId } = this.target();
    await channel.dispatch(targetId, inputCalls(valid, this.stream.metrics));
  }
  require(holder) {
    if (!this.holder || holder !== this.holder) throw problem("NOT_HOLDER");
  }
  /** The CDP channel to the agent's browser and the tab the view shows. */
  target() {
    const targetId = this.stream.state.targetId;
    const port = this.live.browsers.viewProfile(this.stream.id)?.entry?.cdpPort;
    if (!targetId || !port) throw problem("NO_TARGET");
    if (!this.channel || this.channel.cdpPort !== port) {
      // A relaunched browser on another port: the old socket closes.
      this.channel?.close();
      this.channel = this.live.cdpInput(port);
    }
    return { channel: this.channel, targetId };
  }
  /**
   * A toolbar command of the holder (browser-navigation.js): an address goes through
   * the runtime's own navigation, back, forward, reload and stop go to the shown tab
   * over CDP. Every address the owner opens, typed or from the history, passes the
   * agent browser's private-network rule first. Commands run one after another, so
   * a reload pressed during a back waits for it.
   */
  async navigate(holder, command) {
    this.require(holder);
    const valid = validateNavigation(command);
    if (!valid) throw problem("INVALID_NAVIGATION");
    this.touch();
    return this.inOrder(holder, () => this.navigateNow(valid));
  }
  // Nothing queued runs once the lease ended or moved.
  inOrder(holder, run) {
    const next = (this.toolbar || Promise.resolve())
      .catch(() => {})
      .then(() => {
        this.require(holder);
        return run();
      });
    this.toolbar = next;
    return next;
  }
  async navigateNow(valid) {
    if (valid.action === "go") {
      if (!(await this.live.navigationAllowed(valid.url)))
        throw problem("NAVIGATION_BLOCKED");
      return this.stream.navigate(valid.url);
    }
    const { channel, targetId } = this.target();
    const [result] = await channel.dispatch(targetId, historyCalls(valid.action));
    if (!["back", "forward"].includes(valid.action)) return;
    const entry = historyStep(result, valid.action);
    if (!entry) return;
    if (!(await this.live.navigationAllowed(entry.url)))
      throw problem("NAVIGATION_BLOCKED");
    await channel.dispatch(targetId, [
      ["Page.navigateToHistoryEntry", { entryId: entry.id }],
    ]);
  }
  /** Switches to or closes one of the browser's tabs, for the holder. */
  async tab(holder, command) {
    this.require(holder);
    const valid = validateTab(command);
    if (!valid) throw problem("INVALID_NAVIGATION");
    if (!this.stream.state.tabs.some((tab) => tab.targetId === valid.targetId))
      throw problem("NO_TARGET");
    this.touch();
    return this.inOrder(holder, () =>
      valid.action === "switch"
        ? this.stream.focusTab(valid.targetId)
        : this.stream.closeTab(valid.targetId),
    );
  }
  stop() {
    this.release("stopped");
  }
}

export const defaultCdpInput = (port) => new CdpInput(port);
