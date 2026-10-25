/**
 * The owner's live view of an agent's browser (docs/assistant-gateway.md "Live
 * view"). One upstream screencast per agent, shared by every viewer: AgentPier mints
 * a single-use ticket through the Gateway's `browser.request` (POST /screencast on
 * the agent's own profile), opens the ticket's WebSocket on the pinned Gateway
 * connection and hands each frame to the viewers as it arrives. Only the newest
 * frame stays in memory, for a viewer who joins; frames never reach a disk or a log.
 * The upstream closes when the last viewer leaves.
 *
 * Viewers get `state(snapshot)` with `{ status, url, title, targetId, tabs, reason }`
 * and `frame(bytes)` with OpenClaw's binary frame (a four-byte header length, a JSON
 * header and the JPEG). `status` is "connecting", "live", "stopped" (no browser
 * runs), "blocked" (the page's address is not allowed) or "unavailable".
 */
import {
  Takeover,
  defaultCdpInput,
  graceMs,
  leaseMs,
  warnMs,
} from "./browser-takeover.js";

const screencastOptions = { maxWidth: 1280, maxHeight: 1280, quality: 60 };
// Viewers of one agent's browser at once (several tabs and devices of the owner).
export const maxViewers = 8;
// An upstream socket without a first frame by then is given up and retried.
const openTimeoutMs = 10000;
// A user's turn holds a shared browser this long after its last browser call (the
// hand-back lease); then the browser returns to the owner.
export const driverMs = leaseMs;

export class BrowserLiveView {
  constructor({
    browsers,
    runtime,
    pollMs = 3000,
    retryMs = 2000,
    maxRetryMs = 30000,
    closeWaitMs = 1000,
    previewMs = 1000,
    now = Date.now,
    openMs = openTimeoutMs,
    cdpInput = defaultCdpInput,
    onHandBack,
  }) {
    Object.assign(this, { browsers, runtime, pollMs, retryMs, maxRetryMs, previewMs });
    Object.assign(this, { now, openMs, closeWaitMs });
    Object.assign(this, { cdpInput, onHandBack, leaseMs, warnMs, graceMs });
    this.streams = new Map();
    // Whose turn drives each agent's browser: a user's id, or null for the owner.
    this.drivers = new Map();
    // The chat whose turn drove each agent's browser last (browser-hand-back.js).
    this.driverChats = new Map();
    this.driverTimers = new Map();
    // When a turn last used each agent's browser, whoever's it was (the owner's too).
    this.lastUse = new Map();
    this.driverMs = driverMs;
    this.driverWatchers = new Set();
  }
  /** The user whose turn last drove agent `id`'s browser, or null (the owner). */
  driver(id) {
    return this.drivers.get(id) ?? null;
  }
  /** The chat whose turn last drove agent `id`'s browser, or null. */
  driverConversation(id) {
    return this.driverChats.get(id) ?? null;
  }
  /**
   * Whether anyone works with agent `id`'s browser now: a turn used it within the
   * hold (`driverMs`), the owner's turns included, whom `driver` reports as null like
   * an idle browser, or the owner holds it.
   */
  inUse(id) {
    const last = this.lastUse.get(id);
    return (
      (last !== undefined && this.now() - last < this.driverMs) || this.controlled(id)
    );
  }
  /**
   * A turn drives the browser: its person's views stay, anyone else's close.
   * `conversationId` names the chat of that turn, where the hand-back note goes.
   */
  setDriver(id, userId, conversationId = null) {
    this.lastUse.set(id, this.now());
    this.assignDriver(id, userId, conversationId);
  }
  assignDriver(id, userId, conversationId = null) {
    const next = typeof userId === "string" ? userId : null;
    if (typeof conversationId === "string") this.driverChats.set(id, conversationId);
    else this.driverChats.delete(id);
    clearTimeout(this.driverTimers.get(id));
    this.driverTimers.delete(id);
    // Nothing reports a turn's end here: each browser call renews the user's hold.
    if (next !== null) this.expireDriver(id);
    if (this.driver(id) === next) return;
    if (next === null) this.drivers.delete(id);
    else this.drivers.set(id, next);
    for (const watcher of [...this.driverWatchers]) watcher(id);
  }
  // A takeover in progress keeps the hold until it ends; the lease bounds it.
  expireDriver(id) {
    const timer = setTimeout(() => {
      this.driverTimers.delete(id);
      if (this.controlled(id)) this.expireDriver(id);
      else this.assignDriver(id, null);
    }, this.driverMs);
    timer.unref?.();
    this.driverTimers.set(id, timer);
  }
  /** Calls `fn(agentId)` whenever a browser changes hands; returns the unwatch. */
  watchDrivers(fn) {
    this.driverWatchers.add(fn);
    return () => this.driverWatchers.delete(fn);
  }
  /** Whether the owner holds agent `id`'s browser (the tool guard waits then). */
  controlled(id) {
    return !!this.streams.get(id)?.takeover.holder;
  }
  /** The agent was refused during the owner's lease: it gets the hand-back note. */
  refused(id) {
    const takeover = this.streams.get(id)?.takeover;
    if (takeover?.holder) takeover.refused = true;
  }
  /**
   * Adds a viewer of agent `id`. `preview` viewers get at most one frame per
   * `previewMs`. Returns `{ close, select(targetId), follow(), start() }`.
   */
  subscribe(id, viewer, { preview = false, holder = null } = {}) {
    let stream = this.streams.get(id);
    if (!stream) {
      stream = new LiveStream(this, id);
      this.streams.set(id, stream);
    }
    if (stream.viewers.size >= maxViewers)
      throw Object.assign(Error("Too many live viewers"), { code: "LIVE_VIEWERS" });
    const entry = { viewer, preview, holder, last: -Infinity };
    stream.viewers.add(entry);
    // Since when a full viewer watches: the idle stop waits for it, but capped.
    if (!preview && stream.watchingSince == null) stream.watchingSince = this.now();
    viewer.state(stream.snapshot());
    // The screencast sends frames on repaint only: a static page would stay blank.
    if (stream.frame) {
      entry.last = this.now();
      viewer.frame(stream.frame);
    }
    stream.wake();
    stream.takeover.viewsChanged(stream.holders());
    // Only a full view of a known login session takes over and sends input.
    const owner = () => {
      if (preview || !holder)
        throw Object.assign(Error("view only"), { code: "VIEW_ONLY" });
      return holder;
    };
    return {
      close: () => {
        stream.viewers.delete(entry);
        stream.takeover.viewsChanged(stream.holders());
        if (![...stream.viewers].some((other) => !other.preview))
          stream.watchingSince = null;
        // A held lease keeps the stream for its grace; its release ends it then.
        if (!stream.viewers.size && !stream.takeover.holder) this.drop(stream);
      },
      // The owner picks a tab; it stays until the owner follows the agent again.
      select: (targetId) => stream.select(targetId),
      follow: () => stream.select(null),
      start: () => stream.start(),
      stopBrowser: () => stream.stopBrowser(),
      take: ({ move = false } = {}) => stream.takeover.take(owner(), { move }),
      handBack: () => stream.takeover.handBack(owner()),
      input: (command) => stream.takeover.input(owner(), command),
    };
  }
  drop(stream) {
    stream.stop();
    if (this.streams.get(stream.id) === stream) this.streams.delete(stream.id);
  }
  /** Ends every stream and tells its viewers, whose sockets then close. */
  close() {
    for (const timer of this.driverTimers.values()) clearTimeout(timer);
    this.driverTimers.clear();
    for (const stream of this.streams.values()) {
      stream.stop();
      for (const { viewer } of stream.viewers) viewer.end?.();
    }
    this.streams.clear();
  }
}

class LiveStream {
  constructor(live, id) {
    Object.assign(this, { live, id });
    this.viewers = new Set();
    this.state = { status: "connecting", url: "", title: "", targetId: null, tabs: [] };
    this.pinned = null;
    this.upstream = null;
    this.timer = null;
    this.busy = false;
    this.stopped = false;
    this.metrics = null;
    // The upstream's newest frame, in memory only, for a viewer who joins.
    this.frame = null;
    this.takeover = new Takeover(this);
  }
  /** The login sessions with a full view open. */
  holders() {
    return new Set(
      [...this.viewers]
        .filter((entry) => !entry.preview && entry.holder)
        .map((e) => e.holder),
    );
  }
  snapshot() {
    const last = this.live.lastUse.get(this.id);
    return {
      ...this.state,
      tabs: [...this.state.tabs],
      pinned: !!this.pinned,
      // A turn used the browser within the hold: stopping it now interrupts the agent.
      busy: last !== undefined && this.live.now() - last < this.live.driverMs,
      control: this.takeover.snapshot(),
    };
  }
  /** Applies `patch` and sends the snapshot when it differs from the last sent. */
  set(patch) {
    Object.assign(this.state, patch);
    const snapshot = this.snapshot();
    const text = JSON.stringify(snapshot);
    if (text === this.sent) return;
    this.sent = text;
    for (const { viewer } of this.viewers) viewer.state(snapshot);
  }
  request(method, path, body) {
    return this.live.runtime.client.request("browser.request", {
      method,
      path,
      query: { profile: this.profile },
      ...(body ? { body } : {}),
    });
  }
  /** Refreshes now and keeps polling while viewers stay. */
  wake() {
    this.stopped = false;
    clearTimeout(this.timer);
    this.refresh().finally(() => this.schedule(this.live.pollMs));
  }
  schedule(ms) {
    clearTimeout(this.timer);
    if (this.stopped || !this.viewers.size) return;
    this.timer = setTimeout(() => this.wake(), ms);
    this.timer.unref?.();
  }
  async refresh() {
    if (this.stopped) return;
    // A refresh asked for meanwhile (a tab pick) runs once this one is done.
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    this.again = false;
    try {
      const client = this.live.runtime?.client;
      const view = client?.ready ? this.live.browsers.viewProfile(this.id) : null;
      if (!view) {
        this.disconnect();
        return this.set({
          status: "unavailable",
          tabs: [],
          reason: client?.ready ? this.live.browsers.viewReason(this.id) : "service",
        });
      }
      this.profile = view.name;
      const status = await this.request("GET", "/");
      if (!status?.running) {
        this.disconnect();
        // A stopped browser cannot be held; the agent may start it again.
        this.takeover.release("browserStopped");
        return this.set({ status: "stopped", tabs: [], url: "", title: "", reason: "" });
      }
      // Watching keeps it tracked (a visible browser keeps its window keeper);
      // only a full viewer keeps it from the idle stop, a chat's preview never.
      this.live.browsers.watched(this.id, {
        full: this.watchingSince != null,
        since: this.watchingSince ?? this.live.now(),
      });
      const listed = await this.request("GET", "/tabs");
      const tabs = (Array.isArray(listed?.tabs) ? listed.tabs : [])
        .filter((tab) => !tab.type || tab.type === "page")
        .map((tab) => ({
          // The raw CDP target: the ticket and the owner's input both address it.
          targetId: String(tab.targetId || tab.suggestedTargetId || ""),
          title: String(tab.title || "").slice(0, 200),
          url: String(tab.url || "").slice(0, 2048),
        }))
        .filter((tab) => tab.targetId);
      const known = new Set(this.state.tabs.map((tab) => tab.targetId));
      const added = this.state.tabs.length
        ? tabs.filter((tab) => !known.has(tab.targetId))
        : [];
      const opened = added.length > 0;
      // While the owner holds the browser, a tab it opens (a login popup) is shown.
      if (opened && this.takeover.holder) this.pinned = added.at(-1).targetId;
      this.set({ tabs });
      if (this.pinned && !tabs.some((tab) => tab.targetId === this.pinned))
        this.pinned = null;
      const current = this.upstream && this.state.targetId;
      const gone = current && !tabs.some((tab) => tab.targetId === current);
      const wanted = this.pinned && this.pinned !== this.state.targetId;
      // Without a pick it follows the browser's selected tab: a new tab, a closed
      // one or a stream that ended asks for a fresh ticket.
      if (!this.upstream || gone || wanted || (!this.pinned && opened))
        await this.connect(this.pinned || undefined);
    } catch {
      this.disconnect();
      // A blocked page also refuses the next ticket; it stays blocked until it moves.
      this.set(
        this.state.status === "blocked"
          ? {}
          : { status: "unavailable", reason: "request" },
      );
    } finally {
      this.busy = false;
    }
    if (this.again) await this.refresh();
  }
  async connect(targetId) {
    this.disconnect();
    // OpenClaw shares one screencast per tab and starts it afresh, with a first
    // frame, only once its last viewer left: a ticket minted before the old socket
    // closed would join the old capture and show a static page nothing.
    await this.closing;
    if (this.stopped || !this.viewers.size) return;
    const ticket = await this.request("POST", "/screencast", {
      ...screencastOptions,
      ...(targetId ? { targetId } : {}),
    });
    if (this.stopped || !this.viewers.size || typeof ticket?.wsPath !== "string") return;
    const ws = this.live.runtime.client.openStream(ticket.wsPath);
    this.upstream = ws;
    this.set({
      status: "connecting",
      targetId: ticket.targetId || null,
      url: ticket.url || "",
      reason: "",
    });
    // The open budget lasts until the first frame: a socket that opens but sends no
    // picture (a browser that just restarted) is dropped and retried, backing off.
    let framed = false;
    const watchdog = setTimeout(() => {
      if (!framed && this.upstream === ws) {
        this.disconnect();
        this.schedule(this.backoff());
      }
    }, this.live.openMs);
    watchdog.unref?.();
    ws.on("message", (data, binary) => {
      if (binary && !framed) {
        framed = true;
        this.failures = 0;
        clearTimeout(watchdog);
      }
      this.message(ws, data, binary);
    });
    ws.on("error", () => {});
    ws.on("close", (code) => {
      clearTimeout(watchdog);
      if (this.upstream !== ws) return;
      this.upstream = null;
      this.frame = null;
      // 4003: the page's address is blocked; 4004: the tab closed; else retried.
      if (code === 4003) this.set({ status: "blocked", reason: "navigation" });
      else this.set({ status: "connecting" });
      this.schedule(code === 4004 ? 0 : framed ? this.live.retryMs : this.backoff());
    });
  }
  /** The wait before the next try after one without a picture: doubling, capped. */
  backoff() {
    this.failures = (this.failures || 0) + 1;
    const { retryMs, maxRetryMs } = this.live;
    return Math.min(retryMs * 2 ** (this.failures - 1), maxRetryMs);
  }
  message(ws, data, binary) {
    if (this.upstream !== ws) return;
    if (binary) {
      if (this.state.status !== "live") this.set({ status: "live", reason: "" });
      this.metrics = frameMetrics(data) || this.metrics;
      this.frame = data;
      const now = this.live.now();
      for (const entry of this.viewers) {
        if (entry.preview && now - entry.last < this.live.previewMs) continue;
        entry.last = now;
        entry.viewer.frame(data);
      }
      return;
    }
    let message;
    try {
      message = JSON.parse(String(data));
    } catch {
      return;
    }
    if (message?.type === "ready" || message?.type === "meta")
      this.set({
        ...(typeof message.targetId === "string" && { targetId: message.targetId }),
        url:
          typeof message.url === "string" ? message.url.slice(0, 2048) : this.state.url,
        title:
          typeof message.title === "string"
            ? message.title.slice(0, 200)
            : this.state.title,
      });
  }
  select(targetId) {
    this.pinned =
      typeof targetId === "string" && targetId ? targetId.slice(0, 200) : null;
    this.set({});
    if (this.pinned !== this.state.targetId) {
      this.disconnect();
      this.wake();
    }
  }
  async start() {
    await this.live.browsers.ownerStart(this.id);
    this.wake();
  }
  /**
   * Stops the agent's browser; the refresh then reports it stopped. A failed stop
   * leaves it running and is reported to the viewer.
   */
  async stopBrowser() {
    try {
      await this.live.browsers.ownerStop(this.id);
    } catch (error) {
      this.wake();
      throw Object.assign(Error("The browser could not be stopped."), {
        code: "STOP_FAILED",
        cause: error,
      });
    }
    this.disconnect();
    this.wake();
  }
  disconnect() {
    const ws = this.upstream;
    this.upstream = null;
    this.frame = null;
    if (!ws) return;
    // Settles once the upstream closed, or after `closeWaitMs` at most.
    this.closing = new Promise((resolve) => {
      const timer = setTimeout(resolve, this.live.closeWaitMs);
      timer.unref?.();
      ws.once?.("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      ws.close();
    } catch {
      /* Already closed. */
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.disconnect();
    this.takeover.stop();
  }
}

/** The layout viewport of a frame, from its JSON header (cssWidth, cssHeight). */
function frameMetrics(data) {
  try {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
    const length = bytes.readUInt32BE(0);
    if (length > 65536 || length + 4 > bytes.length) return null;
    const header = JSON.parse(bytes.subarray(4, 4 + length).toString("utf8"));
    return header.cssWidth > 0 && header.cssHeight > 0
      ? { cssWidth: header.cssWidth, cssHeight: header.cssHeight }
      : null;
  } catch {
    return null;
  }
}
