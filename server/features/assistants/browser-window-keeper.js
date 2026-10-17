/**
 * Watches one agent browser through its CDP port: `onClose` reports when it ends
 * (a stop, a crash, or no browser within `timeoutMs`). For a visible browser
 * (`windows`) it also keeps it out of the owner's way: it minimizes the windows a
 * fresh launch opens and keeps every page rendering while minimized. A minimized
 * Chromium window marks its pages hidden and stops painting them; focus emulation,
 * held by this CDP session, keeps them visible to the page and to OpenClaw's
 * screenshots and actions. Windows opened later (a login popup, a window the owner
 * restored) are left as they are. The CDP port is loopback-only and unauthenticated;
 * only the AgentPier server, the Gateway's owner, connects here.
 */
const launchWindowMs = 10000;
// A CDP call that takes longer never holds a limit check or an idle sweep.
const commandTimeoutMs = 2000;
export class BrowserWindowKeeper {
  constructor(
    cdpPort,
    {
      now = Date.now,
      fetch = globalThis.fetch,
      timeoutMs = 30000,
      windows = true,
      onClose = () => {},
    } = {},
  ) {
    Object.assign(this, { cdpPort, now, fetch, timeoutMs, windows, onClose });
    this.closed = false;
    this.attached = new Set();
    this.known = new Set();
    this.pending = new Map();
    this.id = 0;
  }
  /** Connects once the browser answers; resolves when it is watched or gave up. */
  async start() {
    const deadline = this.now() + this.timeoutMs;
    let version,
      polls = 0;
    while (!this.closed && !version && this.now() < deadline) {
      polls++;
      try {
        const response = await this.fetch(
          `http://127.0.0.1:${this.cdpPort}/json/version`,
        );
        version = response.ok ? await response.json() : null;
      } catch {
        /* Not launched yet. */
      }
      if (!version) await new Promise((r) => setTimeout(r, 250).unref?.());
    }
    if (this.closed || !version?.webSocketDebuggerUrl) {
      this.finish();
      return false;
    }
    // Only a browser that came up while we waited is a fresh launch whose windows
    // are minimized; one already running may hold windows the owner restored.
    this.launchedAt = polls > 1 ? this.now() : null;
    await this.connect(version.webSocketDebuggerUrl);
    return !this.closed;
  }
  finish() {
    const first = !this.ended;
    this.closed = this.ended = true;
    for (const { reject } of this.pending.values()) reject(Error("closed"));
    this.pending.clear();
    try {
      this.ws?.close();
    } catch {
      /* Already closed. */
    }
    if (first) this.onClose();
  }
  /** Whether the owner has one of the browser's windows open (not minimized). */
  async inUse() {
    for (const windowId of this.known) {
      try {
        const { bounds } = await this.send("Browser.getWindowBounds", { windowId });
        if (bounds?.windowState && bounds.windowState !== "minimized") return true;
      } catch {
        /* Closed meanwhile. */
      }
    }
    return false;
  }
  connect(url) {
    return new Promise((resolve) => {
      const ws = (this.ws = new WebSocket(url));
      ws.onopen = async () => {
        ws.onmessage = (event) => this.message(event.data);
        try {
          await this.send("Target.setDiscoverTargets", { discover: true });
          const { targetInfos = [] } = await this.send("Target.getTargets");
          await Promise.all(targetInfos.map((info) => this.page(info)));
        } catch {
          /* The browser went away meanwhile. */
        }
        resolve();
      };
      // Node reports a failed connection by an error alone, without close.
      ws.onerror = () => {
        this.finish();
        resolve();
      };
      ws.onclose = () => {
        for (const { reject } of this.pending.values()) reject(Error("closed"));
        this.pending.clear();
        this.finish();
        resolve();
      };
    });
  }
  /** One CDP call; a browser that does not answer within `timeoutMs` fails it. */
  send(method, params = {}, sessionId, timeoutMs = commandTimeoutMs) {
    if (this.closed || this.ws?.readyState !== 1) return Promise.reject(Error("closed"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error("timeout"));
      }, timeoutMs);
      timer.unref?.();
      const done = (fn) => (value) => {
        clearTimeout(timer);
        fn(value);
      };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this.ws.send(
        JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }),
      );
    });
  }
  message(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.id && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(Error(msg.error.message || "CDP error"));
      else resolve(msg.result || {});
    } else if (
      msg.method === "Target.targetCreated" ||
      msg.method === "Target.targetInfoChanged"
    )
      this.page(msg.params?.targetInfo).catch(() => {});
  }
  async page(info) {
    if (
      !this.windows ||
      !info ||
      info.type !== "page" ||
      this.attached.has(info.targetId)
    )
      return;
    this.attached.add(info.targetId);
    try {
      const { sessionId } = await this.send("Target.attachToTarget", {
        targetId: info.targetId,
        flatten: true,
      });
      await this.send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
      const { windowId } = await this.send("Browser.getWindowForTarget", {
        targetId: info.targetId,
      });
      if (this.known.has(windowId)) return;
      this.known.add(windowId);
      if (this.launchedAt !== null && this.now() - this.launchedAt <= launchWindowMs)
        await this.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "minimized" },
        });
    } catch {
      /* The page closed meanwhile. */
    }
  }
  /** Stops watching; `onClose` is not called for a close AgentPier asked for. */
  close() {
    this.closed = this.ended = true;
    try {
      this.ws?.close();
    } catch {
      /* Already closed. */
    }
  }
}
