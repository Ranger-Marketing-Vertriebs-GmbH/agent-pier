import { promises as dns } from "node:dns";
import { navigationAllowed } from "../../browser-navigation.js";
import { metadataHosts } from "./hermes-browser-control.js";

// AgentPier's navigation guard on a Hermes agent's own Chromium (hermes-browser.js).
// Hermes's browser_exec runs the agent's Python against the browser over raw CDP
// (tools/browser_use_cli.py); Hermes refuses only the private addresses it finds
// written in that code (tools/browser_url_policy.py), so an address the code builds,
// a redirect or a page's own link is not checked there. The guard holds the browser
// itself to the owner's **Allow private networks for all agent browsers**: it keeps
// one CDP connection to the browser and intercepts every document request there
// (Fetch on the browser target, request stage), whatever page, frame, window or
// browser context makes it, before it leaves the browser: an address that is not
// public is failed (`BlockedByClient`) unless the owner allows private networks;
// cloud metadata addresses are failed either way. Like OpenClaw's policy it checks
// the documents the browser goes to, redirects included, not the requests a page
// makes. A browser whose guard is gone is stopped (`onLost`).

const startTimeoutMs = 10000;
const metadataAddresses = new Set(
  [...metadataHosts].map((host) => host.replace(/^\[|\]$/g, "")),
);

/**
 * Whether the browser may load the document at `url`: anything but http(s) passes
 * (the guard sees network requests only), cloud metadata addresses never, and a
 * private, loopback or link-local address only with `allowPrivateNetwork`
 * (browser-navigation.js; a name that does not resolve is refused).
 */
export async function documentAllowed(
  url,
  {
    allowPrivateNetwork = false,
    lookup = (host) => dns.lookup(host, { all: true }),
  } = {},
) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return true;
  const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (metadataAddresses.has(host)) return false;
  if (allowPrivateNetwork) {
    try {
      const addresses = await lookup(host);
      return !addresses.some(({ address }) => metadataAddresses.has(address));
    } catch {
      return true;
    }
  }
  // Credentials in the address change nothing about where it leads.
  parsed.username = "";
  parsed.password = "";
  return navigationAllowed(parsed.href, { allowPrivateNetwork: false, lookup });
}

const documents = [
  { urlPattern: "*", resourceType: "Document", requestStage: "Request" },
];

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
  }) {
    Object.assign(this, { socketUrl, allowPrivateNetwork, onLost, WebSocketImpl });
    this.lookup = lookup;
    this.id = 0;
    this.pending = new Map();
    this.closed = false;
  }
  /** Connects and intercepts the browser's document requests; rejects when that fails. */
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
        this.send("Fetch.enable", { patterns: documents }).then(
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
    if (message.method === "Fetch.requestPaused")
      this.paused(message.sessionId, message.params || {}).catch(() => {});
  }
  async paused(sessionId, { requestId, request }) {
    const allowed = await documentAllowed(String(request?.url || ""), {
      allowPrivateNetwork: this.allowPrivateNetwork,
      ...(this.lookup && { lookup: this.lookup }),
    }).catch(() => false);
    await (allowed
      ? this.send("Fetch.continueRequest", { requestId }, sessionId)
      : this.send(
          "Fetch.failRequest",
          { requestId, errorReason: "BlockedByClient" },
          sessionId,
        ));
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
