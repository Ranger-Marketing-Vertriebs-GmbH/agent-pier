import { CdpInput, inputCalls, validateInput } from "./browser-input.js";

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
  take(holder) {
    if (this.holder && this.holder !== holder) throw problem("LEASE_HELD");
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
    // A shutdown is no hand-back the agent should act on.
    if (reason !== "stopped") this.live.onHandBack?.(this.stream.id, reason);
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
    if (!this.holder || holder !== this.holder) throw problem("NOT_HOLDER");
    const valid = validateInput(command);
    if (!valid) throw problem("INVALID_INPUT");
    this.touch();
    const targetId = this.stream.state.targetId;
    const port = this.live.browsers.viewProfile(this.stream.id)?.entry?.cdpPort;
    if (!targetId || !port) throw problem("NO_TARGET");
    if (!this.channel || this.channel.cdpPort !== port)
      this.channel = this.live.cdpInput(port);
    await this.channel.dispatch(targetId, inputCalls(valid, this.stream.metrics));
  }
  stop() {
    this.release("stopped");
  }
}

export const defaultCdpInput = (port) => new CdpInput(port);
