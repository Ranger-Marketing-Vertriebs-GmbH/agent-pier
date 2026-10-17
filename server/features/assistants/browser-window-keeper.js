/**
 * Keeps a visible agent browser out of the owner's way: it minimizes the windows the
 * browser opens at launch and keeps every page rendering while minimized. A minimized
 * Chromium window marks its pages hidden and stops painting them; focus emulation,
 * held by this CDP session, keeps them visible to the page and to OpenClaw's
 * screenshots and actions. Windows opened later (a login popup, a window the owner
 * restored) are left as they are. The CDP port is loopback-only and unauthenticated;
 * only the AgentPier server, the Gateway's owner, connects here.
 */
const launchWindowMs = 10000;
export class BrowserWindowKeeper {
  constructor(
    cdpPort,
    { now = Date.now, fetch = globalThis.fetch, timeoutMs = 30000 } = {},
  ) {
    Object.assign(this, { cdpPort, now, fetch, timeoutMs });
    this.closed = false;
    this.attached = new Set();
    this.windows = new Set();
    this.pending = new Map();
    this.id = 0;
  }
  /** Connects once the browser answers; resolves when it is watched or gave up. */
  async start() {
    const deadline = this.now() + this.timeoutMs;
    let version;
    while (!this.closed && !version && this.now() < deadline) {
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
    if (this.closed || !version?.webSocketDebuggerUrl) return false;
    this.startedAt = this.now();
    await this.connect(version.webSocketDebuggerUrl);
    return true;
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
      ws.onerror = () => resolve();
      ws.onclose = () => {
        this.closed = true;
        for (const { reject } of this.pending.values()) reject(Error("closed"));
        this.pending.clear();
        resolve();
      };
    });
  }
  send(method, params = {}, sessionId) {
    if (this.closed || this.ws?.readyState !== 1) return Promise.reject(Error("closed"));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
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
    if (!info || info.type !== "page" || this.attached.has(info.targetId)) return;
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
      if (this.windows.has(windowId)) return;
      this.windows.add(windowId);
      if (this.now() - this.startedAt <= launchWindowMs)
        await this.send("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "minimized" },
        });
    } catch {
      /* The page closed meanwhile. */
    }
  }
  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* Already closed. */
    }
  }
}
