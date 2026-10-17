/**
 * The owner's live view of an agent's browser (docs/assistant-gateway.md "Live
 * view"). One upstream screencast per agent, shared by every viewer: AgentPier mints
 * a single-use ticket through the Gateway's `browser.request` (POST /screencast on
 * the agent's own profile), opens the ticket's WebSocket on the pinned Gateway
 * connection and hands each frame to the viewers as it arrives. Nothing is stored;
 * frames never reach a log. The upstream closes when the last viewer leaves.
 *
 * Viewers get `state(snapshot)` with `{ status, url, title, targetId, tabs, reason }`
 * and `frame(bytes)` with OpenClaw's binary frame (a four-byte header length, a JSON
 * header and the JPEG). `status` is "connecting", "live", "stopped" (no browser
 * runs), "blocked" (the page's address is not allowed) or "unavailable".
 */
const screencastOptions = { maxWidth: 1280, maxHeight: 1280, quality: 60 };

export class BrowserLiveView {
  constructor({
    browsers,
    runtime,
    pollMs = 3000,
    retryMs = 2000,
    previewMs = 1000,
    now = Date.now,
  }) {
    Object.assign(this, { browsers, runtime, pollMs, retryMs, previewMs, now });
    this.streams = new Map();
  }
  /**
   * Adds a viewer of agent `id`. `preview` viewers get at most one frame per
   * `previewMs`. Returns `{ close, select(targetId), follow(), start() }`.
   */
  subscribe(id, viewer, { preview = false } = {}) {
    let stream = this.streams.get(id);
    if (!stream) {
      stream = new LiveStream(this, id);
      this.streams.set(id, stream);
    }
    const entry = { viewer, preview, last: -Infinity };
    stream.viewers.add(entry);
    viewer.state(stream.snapshot());
    stream.wake();
    return {
      close: () => {
        stream.viewers.delete(entry);
        if (!stream.viewers.size) {
          stream.stop();
          if (this.streams.get(id) === stream) this.streams.delete(id);
        }
      },
      // The owner picks a tab; it stays until the owner follows the agent again.
      select: (targetId) => stream.select(targetId),
      follow: () => stream.select(null),
      start: () => stream.start(),
    };
  }
  close() {
    for (const stream of this.streams.values()) stream.stop();
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
  }
  snapshot() {
    return { ...this.state, tabs: [...this.state.tabs], pinned: !!this.pinned };
  }
  set(patch) {
    const before = JSON.stringify(this.snapshot());
    Object.assign(this.state, patch);
    if (JSON.stringify(this.snapshot()) === before) return;
    const snapshot = this.snapshot();
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
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      const client = this.live.runtime?.client;
      const view = client?.ready ? this.live.browsers.viewProfile(this.id) : null;
      if (!view) {
        this.disconnect();
        return this.set({
          status: "unavailable",
          tabs: [],
          reason: client?.ready ? "noProfile" : "service",
        });
      }
      this.profile = view.name;
      const status = await this.request("GET", "/");
      if (!status?.running) {
        this.disconnect();
        return this.set({ status: "stopped", tabs: [], url: "", title: "", reason: "" });
      }
      // Watching keeps it tracked: a visible browser keeps rendering minimized.
      this.live.browsers.watched(this.id);
      const listed = await this.request("GET", "/tabs");
      const tabs = (Array.isArray(listed?.tabs) ? listed.tabs : [])
        .filter((tab) => !tab.type || tab.type === "page")
        .map((tab) => ({
          targetId: String(tab.suggestedTargetId || tab.targetId || ""),
          title: String(tab.title || "").slice(0, 200),
          url: String(tab.url || "").slice(0, 2048),
        }))
        .filter((tab) => tab.targetId);
      const known = new Set(this.state.tabs.map((tab) => tab.targetId));
      const opened =
        tabs.some((tab) => !known.has(tab.targetId)) && this.state.tabs.length;
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
  }
  async connect(targetId) {
    this.disconnect();
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
    ws.on("message", (data, binary) => this.message(ws, data, binary));
    ws.on("error", () => {});
    ws.on("close", (code) => {
      if (this.upstream !== ws) return;
      this.upstream = null;
      // 4003: the page's address is blocked; 4004: the tab closed; else retried.
      if (code === 4003) this.set({ status: "blocked", reason: "navigation" });
      else this.set({ status: "connecting" });
      this.schedule(code === 4004 ? 0 : this.live.retryMs);
    });
  }
  message(ws, data, binary) {
    if (this.upstream !== ws) return;
    if (binary) {
      if (this.state.status !== "live") this.set({ status: "live", reason: "" });
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
  disconnect() {
    const ws = this.upstream;
    this.upstream = null;
    try {
      ws?.close();
    } catch {
      /* Already closed. */
    }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.disconnect();
  }
}
