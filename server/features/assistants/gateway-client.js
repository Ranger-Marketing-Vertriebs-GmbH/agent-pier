import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import WebSocket from "ws";
import { gatewayHandshake, gatewayError } from "./gateway-protocol.js";
import { readGatewayPin } from "./gateway-tls.js";

// The token is a bearer secret, so only a Gateway holding the private key of the
// certificate in our private runtime folder may receive it. The pin is re-read on
// every connection so a regenerated certificate takes effect after restarts.
// `handshake` records whether TCP connected and whether TLS completed: anything
// that fails in between is a foreign listener, not a Gateway still starting.
function pinnedSocket(url, certPath, handshake) {
  if (!/^wss:\/\//.test(url) || !certPath) throw gatewayError("ENDPOINT_UNTRUSTED");
  let pin;
  try {
    pin = readGatewayPin(certPath);
  } catch {
    throw gatewayError("ENDPOINT_UNTRUSTED");
  }
  return new WebSocket(url, {
    maxPayload: 16 * 1024 * 1024,
    // As ws's own TLS connector, plus the handshake phase.
    createConnection: (options) => {
      const socket = tls.connect({
        ...options,
        path: undefined,
        servername: net.isIP(options.host) ? "" : options.servername || options.host,
      });
      socket.once("connect", () => (handshake.connected = true));
      socket.once("secureConnect", () => (handshake.secured = true));
      return socket;
    },
    ca: pin.cert,
    rejectUnauthorized: true,
    checkServerIdentity: (_host, certificate) =>
      certificate?.fingerprint256 === pin.fingerprint
        ? undefined
        : gatewayError("ENDPOINT_UNTRUSTED"),
  });
}

// The first sessions.create of a Gateway process loads OpenClaw's session handlers
// and their module graph lazily, after a fresh install without a warm compile
// cache: about 1 s on a fast host, more than 10 s on a slow or busy one (AGENTPIER-50
// on Intel macOS runners); later calls take milliseconds. Waiting is the only safe
// option: a timed-out create leaves it unknown whether the session exists.
export const sessionCreateTimeoutMs = 60000;
// What GatewayClient.download may read: OpenClaw's managed outgoing media.
const downloadPaths = ["/api/chat/media/outgoing/"];

export class GatewayClient extends EventEmitter {
  constructor({ url, token, certPath, timeoutMs = 10000, caps = [] }) {
    super();
    Object.assign(this, { url, token, certPath, timeoutMs, caps });
    this.pending = new Map();
    this.ready = false;
  }
  async connect() {
    if (this.ready) return;
    this.close();
    const handshake = { connected: false, secured: false };
    const ws = (this.ws = pinnedSocket(this.url, this.certPath, handshake));
    await new Promise((resolve, reject) => {
      let challenged = false;
      const timer = setTimeout(() => {
        reject(gatewayError("TIMEOUT"));
        ws.terminate();
      }, this.timeoutMs);
      const fail = (error) => {
        clearTimeout(timer);
        reject(
          gatewayError(
            (handshake.connected && !handshake.secured) ||
              /CERT|SELF_SIGNED|ENDPOINT_UNTRUSTED|^ERR_SSL|^EPROTO$/.test(error?.code)
              ? "ENDPOINT_UNTRUSTED"
              : undefined,
          ),
        );
      };
      ws.on("error", fail);
      ws.on("close", () => {
        if (this.ws !== ws) return;
        fail();
        this.ready = false;
        this.rejectPending();
        this.emit("disconnected");
      });
      ws.on("message", (bytes) => {
        let frame;
        try {
          frame = JSON.parse(String(bytes));
        } catch {
          return;
        }
        if (frame.type === "res") {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          // Gateway may acknowledge a long-running RPC before its final response.
          if (frame.payload?.status === "accepted" && pending.final) return;
          clearTimeout(pending.timer);
          this.pending.delete(frame.id);
          if (frame.ok) pending.resolve(frame.payload);
          else
            // `answered` separates a Gateway reply from a local transport failure.
            pending.reject(
              Object.assign(
                gatewayError(
                  /^[A-Z_]{1,60}$/.test(frame.error?.code)
                    ? frame.error.code
                    : "RPC_FAILED",
                ),
                {
                  answered: true,
                  // OpenClaw marks an answer that did nothing and may be repeated
                  // (sessions.create while its model catalog loads, 2026.10.3).
                  ...(frame.error?.retryable === true ? { retryable: true } : {}),
                  // The Gateway's reason, only for callers that must tell one
                  // INVALID_REQUEST from another (a stale base hash); never
                  // logged or shown.
                  ...(frame.error?.code === "INVALID_REQUEST" &&
                  typeof frame.error.message === "string"
                    ? { remoteMessage: frame.error.message.slice(0, 300) }
                    : {}),
                  // OpenClaw answers an error its handler threw as UNAVAILABLE with
                  // "<class name>: <message> <- <causes>". Only the class name is
                  // kept: it tells a refusal before any write from other failures
                  // (session-create.js); the text may carry host paths.
                  ...(frame.error?.code === "UNAVAILABLE" &&
                  /^[A-Z][A-Za-z]{0,80}Error(?=: )/.test(frame.error.message)
                    ? { remoteError: frame.error.message.split(":", 1)[0] }
                    : {}),
                  // A plugin method's failure whose whole message is a stable code
                  // (team-plugin/chat-title.js): no text, so it may be logged.
                  ...(frame.error?.code === "UNAVAILABLE" &&
                  /^[A-Z][A-Z_]{2,60}$/.test(frame.error.message)
                    ? { remoteCode: frame.error.message }
                    : {}),
                },
              ),
            );
        } else if (frame.type === "event") {
          if (frame.event === "connect.challenge" && !challenged) {
            challenged = true;
            this.request("connect", gatewayHandshake(this.token, this.caps))
              .then((hello) => {
                if (hello?.protocol !== 4) throw gatewayError("PROTOCOL_MISMATCH");
                const features = hello?.features || {};
                this.features = {
                  methods: new Set(
                    Array.isArray(features.methods) ? features.methods : [],
                  ),
                  events: new Set(Array.isArray(features.events) ? features.events : []),
                };
                clearTimeout(timer);
                this.ready = true;
                resolve();
              })
              .catch((error) => {
                clearTimeout(timer);
                reject(error);
                ws.terminate();
              });
          } else this.emit("event", frame);
        }
      });
    });
  }
  call(method, params = {}, options = {}) {
    if (!this.ready) return Promise.reject(gatewayError());
    return this.request(method, params, options);
  }
  request(method, params, { timeoutMs = this.timeoutMs, final = false } = {}) {
    return new Promise((resolve, reject) => {
      if (this.ws?.readyState !== WebSocket.OPEN) return reject(gatewayError());
      const id = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(gatewayError("TIMEOUT"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, final });
      this.ws.send(JSON.stringify({ type: "req", id, method, params }), (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(gatewayError());
      });
    });
  }
  /**
   * A further WebSocket to this Gateway, pinned like the RPC connection, for a
   * single-use path such as a browser screencast ticket's `wsPath`.
   */
  openStream(wsPath) {
    if (typeof wsPath !== "string" || !wsPath.startsWith("/") || wsPath.startsWith("//"))
      throw gatewayError("RPC_FAILED");
    const url = new URL(wsPath, this.url);
    // A path like "/\\evil" would resolve to another host; it stays on the Gateway.
    if (
      url.host !== new URL(this.url).host ||
      url.protocol !== new URL(this.url).protocol
    )
      throw gatewayError("RPC_FAILED");
    return pinnedSocket(url.href, this.certPath, { connected: false, secured: false });
  }
  /**
   * Reads one file the Gateway serves on its own HTTPS origin (a managed media path
   * with its short-lived ticket, as artifacts.download returns it), pinned like the
   * RPC connection and bounded to `maxBytes`. Never sends the Gateway token.
   */
  download(urlPath, { maxBytes, timeoutMs = 30000 } = {}) {
    if (
      typeof urlPath !== "string" ||
      !urlPath.startsWith("/") ||
      urlPath.startsWith("//")
    )
      return Promise.reject(gatewayError("RPC_FAILED"));
    const base = new URL(this.url.replace(/^wss:/, "https:"));
    const url = new URL(urlPath, base);
    // Only managed media paths, checked after resolution (no "..", no other origin).
    if (
      url.host !== base.host ||
      url.protocol !== "https:" ||
      !downloadPaths.some((prefix) => url.pathname.startsWith(prefix))
    )
      return Promise.reject(gatewayError("RPC_FAILED"));
    let pin;
    try {
      pin = readGatewayPin(this.certPath);
    } catch {
      return Promise.reject(gatewayError("ENDPOINT_UNTRUSTED"));
    }
    return new Promise((resolve, reject) => {
      const request = https.get(
        url,
        {
          ca: pin.cert,
          rejectUnauthorized: true,
          servername: net.isIP(url.hostname) ? "" : url.hostname,
          checkServerIdentity: (_host, certificate) =>
            certificate?.fingerprint256 === pin.fingerprint
              ? undefined
              : gatewayError("ENDPOINT_UNTRUSTED"),
          timeout: timeoutMs,
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            return reject(gatewayError("RPC_FAILED"));
          }
          const chunks = [];
          let size = 0;
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > maxBytes) {
              request.destroy();
              return reject(
                Object.assign(gatewayError("RPC_FAILED"), { tooLarge: true }),
              );
            }
            chunks.push(chunk);
          });
          response.on("end", () =>
            resolve({
              body: Buffer.concat(chunks),
              type: String(response.headers["content-type"] || ""),
            }),
          );
          response.on("error", () => reject(gatewayError("RPC_FAILED")));
        },
      );
      request.on("timeout", () => request.destroy(gatewayError("RPC_FAILED")));
      request.on("error", (error) =>
        reject(error?.code === "ENDPOINT_UNTRUSTED" ? error : gatewayError("RPC_FAILED")),
      );
    });
  }
  /**
   * A further connection to this Gateway, pinned and authenticated like this one, for
   * a subscription that must not reach the main connection's event handling
   * (compaction-watch.js). It declares no caps, so it never answers exec approvals.
   */
  sibling() {
    return new GatewayClient({
      url: this.url,
      token: this.token,
      certPath: this.certPath,
      timeoutMs: this.timeoutMs,
    });
  }
  supports(method) {
    return !!this.features?.methods.has(method);
  }
  subscribe(listener) {
    this.on("event", listener);
    return () => this.off("event", listener);
  }
  rejectPending() {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(
        Object.assign(Error("Assistant Gateway closed."), {
          code: "CLOSED",
          status: 503,
        }),
      );
    }
    this.pending.clear();
  }
  close() {
    this.ready = false;
    this.features = undefined;
    this.rejectPending();
    if (this.ws) {
      this.ws.removeAllListeners("message");
      this.ws.terminate();
      this.ws = null;
    }
  }
}
