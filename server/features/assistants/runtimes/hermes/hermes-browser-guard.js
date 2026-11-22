import { promises as dns } from "node:dns";
import net from "node:net";
import {
  metadataAddress,
  metadataHosts,
  navigationAllowed,
  privateAddress,
} from "../../browser-navigation.js";

// AgentPier's navigation guard on a Hermes agent's own Chromium (hermes-browser.js).
// Hermes's browser_exec and browser_cdp drive the browser over raw CDP; Hermes
// refuses only the private addresses it finds written in a call
// (tools/browser_url_policy.py), so an address the code builds, a redirect or a
// page's own request is not checked there. The guard holds the browser itself to the
// owner's **Allow private networks for all agent browsers** over one CDP connection:
//
// - Every request (Fetch on the browser target, request stage), whatever page, frame,
//   worker, window or browser context makes it and redirects included, waits for the
//   guard before it leaves the browser: an address that is not public fails
//   (`BlockedByClient`) unless the owner allows private networks, a cloud metadata
//   address and any `file:` or `filesystem:` request fail either way. An IPv6 form of
//   an IPv4 address counts as that address, and a name that does not resolve fails.
// - Each page and frame is attached as it starts (auto-attach, paused until the
//   guard is in place) and its answers are watched (Network): one that came from an
//   address the guard would have refused (the name resolved otherwise when Chromium
//   connected: DNS rebinding) closes that page.
// - A page showing one of the browser's own pages (`chrome:`, `devtools:`; Fetch never
//   sees them) is closed; the new tab page stays.
//
// Not covered, as in OpenClaw's policy: WebSocket connections (no Fetch interception;
// a page reaches a private address over one only where the browser lets it), and the
// time between a rebinding answer and the page's close. A browser whose guard is gone
// is stopped (`onLost`).

const startTimeoutMs = 10000;
// A verdict on a name holds this long (every subresource asks).
const verdictMs = 30000;
const refusedSchemes = new Set(["file:", "filesystem:"]);
// The browser's own pages a page target may not show; the new tab page may.
const browserPage = /^(?:chrome|chrome-untrusted|devtools|view-source):/i;
const newTab = /^chrome:\/\/(?:newtab|new-tab-page)\/?/i;
const documentTargets = new Set(["page", "iframe"]);
const attach = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

const resolver = (host) => dns.lookup(host, { all: true });

/**
 * Whether the browser may load `url`: a web address whose every address is public,
 * or with `allowPrivateNetwork` any but a cloud metadata address (a name that does
 * not resolve is refused either way); never `file:` or `filesystem:`; other schemes
 * (data:, blob:, the browser's own extensions) never reach the network.
 */
export async function documentAllowed(
  url,
  { allowPrivateNetwork = false, lookup = resolver } = {},
) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (refusedSchemes.has(parsed.protocol)) return false;
  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return true;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (metadataHosts.has(host) || metadataAddress(host)) return false;
  if (!allowPrivateNetwork) {
    // Credentials in the address change nothing about where it leads.
    parsed.username = "";
    parsed.password = "";
    if (["ws:", "wss:"].includes(parsed.protocol))
      parsed.protocol = parsed.protocol === "ws:" ? "http:" : "https:";
    return navigationAllowed(parsed.href, { allowPrivateNetwork: false, lookup });
  }
  // An address written out is the one the browser reaches; a name is resolved.
  if (net.isIP(host)) return true;
  try {
    const addresses = await lookup(host);
    return (
      Array.isArray(addresses) &&
      addresses.length > 0 &&
      !addresses.some(({ address }) => metadataAddress(address))
    );
  } catch {
    return false;
  }
}

/** Whether an answer from `address` (an IP address, or none) is one to refuse. */
export function addressRefused(address, { allowPrivateNetwork = false } = {}) {
  if (typeof address !== "string" || !address) return false;
  if (metadataAddress(address)) return true;
  return !allowPrivateNetwork && privateAddress(address);
}

export class NavigationGuard {
  /**
   * `socketUrl`: the browser's own CDP WebSocket on loopback; `allowPrivateNetwork`:
   * the owner's setting at launch; `onLost()`: the connection ended while the guard
   * ran.
   */
  constructor({
    socketUrl,
    allowPrivateNetwork = false,
    onLost = () => {},
    WebSocketImpl = globalThis.WebSocket,
    lookup,
    now = Date.now,
  }) {
    Object.assign(this, { socketUrl, allowPrivateNetwork, onLost, WebSocketImpl, now });
    this.lookup = lookup || resolver;
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
    // Attached page and frame sessions: sessionId → targetId.
    this.sessions = new Map();
    this.verdicts = new Map();
  }
  /** Connects and puts the guard in place; rejects when that fails. */
  start() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(Error("BROWSER_GUARD_TIMEOUT"));
        this.close();
      }, startTimeoutMs);
      const ws = new this.WebSocketImpl(this.socketUrl);
      this.ws = ws;
      let started = false;
      ws.onopen = () =>
        Promise.all([
          this.send("Fetch.enable", {
            patterns: [{ urlPattern: "*", requestStage: "Request" }],
          }),
          this.send("Target.setDiscoverTargets", { discover: true }),
          this.send("Target.setAutoAttach", attach),
        ]).then(
          () => {
            started = true;
            clearTimeout(timer);
            resolve();
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
            this.close();
          },
        );
      ws.onmessage = (event) => this.receive(event.data);
      ws.onerror = () => {};
      ws.onclose = () => {
        for (const { reject: fail } of this.pending.values()) fail(Error("closed"));
        this.pending.clear();
        if (!started) {
          clearTimeout(timer);
          reject(Error("BROWSER_GUARD_CLOSED"));
        }
        const lost = !this.closed;
        this.closed = true;
        if (lost && started) this.onLost();
      };
    });
  }
  send(method, params = {}, sessionId) {
    if (this.closed || this.ws?.readyState !== 1) return Promise.reject(Error("closed"));
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  receive(data) {
    let message;
    try {
      message = JSON.parse(
        typeof data === "string" ? data : Buffer.from(data).toString(),
      );
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const call = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) call?.reject(Error(message.error.message || "cdp"));
      else call?.resolve(message.result);
      return;
    }
    const params = message.params || {};
    const done = (promise) => promise.catch(() => {});
    if (message.method === "Fetch.requestPaused")
      done(this.paused(message.sessionId, params));
    else if (message.method === "Target.attachedToTarget") done(this.attached(params));
    else if (message.method === "Target.detachedFromTarget")
      this.sessions.delete(params.sessionId);
    else if (
      ["Target.targetCreated", "Target.targetInfoChanged"].includes(message.method)
    )
      done(this.shown(params.targetInfo));
    else if (message.method === "Network.responseReceived")
      done(this.answered(message.sessionId, params));
  }
  async allowed(url) {
    let key = url;
    try {
      const parsed = new URL(url);
      key = `${parsed.protocol}//${parsed.hostname}`;
    } catch {
      return false;
    }
    const saved = this.verdicts.get(key);
    if (saved && saved.until > this.now()) return saved.allowed;
    const allowed = await documentAllowed(url, {
      allowPrivateNetwork: this.allowPrivateNetwork,
      lookup: this.lookup,
    }).catch(() => false);
    this.verdicts.set(key, { allowed, until: this.now() + verdictMs });
    return allowed;
  }
  async paused(sessionId, { requestId, request }) {
    const allowed = await this.allowed(String(request?.url || ""));
    await (allowed
      ? this.send("Fetch.continueRequest", { requestId }, sessionId)
      : this.send(
          "Fetch.failRequest",
          { requestId, errorReason: "BlockedByClient" },
          sessionId,
        ));
  }
  // A page, frame or worker that started: watched before it runs on.
  async attached({ sessionId, targetInfo }) {
    if (!sessionId) return;
    const calls = [];
    if (documentTargets.has(targetInfo?.type)) {
      this.sessions.set(sessionId, targetInfo.targetId);
      calls.push(
        this.send("Network.enable", {}, sessionId),
        this.send("Target.setAutoAttach", attach, sessionId),
      );
    }
    // Commands of one session run in order: the run comes after the watch.
    calls.push(this.send("Runtime.runIfWaitingForDebugger", {}, sessionId));
    await Promise.allSettled(calls);
    if (documentTargets.has(targetInfo?.type)) await this.shown(targetInfo);
  }
  // An answer from an address the guard refuses closes its page.
  async answered(sessionId, { response }) {
    const targetId = this.sessions.get(sessionId);
    if (!targetId) return;
    if (!addressRefused(response?.remoteIPAddress, this)) return;
    await this.send("Target.closeTarget", { targetId });
  }
  // A page that shows one of the browser's own pages is closed.
  async shown(info) {
    if (info?.type !== "page" || typeof info.url !== "string") return;
    if (!browserPage.test(info.url) || newTab.test(info.url)) return;
    await this.send("Target.closeTarget", { targetId: info.targetId });
  }
  /** Ends the connection; no `onLost` follows. */
  close() {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      /* Closed already. */
    }
  }
}
