import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
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

export class GatewayClient extends EventEmitter {
  constructor({ url, token, certPath, timeoutMs = 10000 }) {
    super();
    Object.assign(this, { url, token, certPath, timeoutMs });
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
                { answered: true },
              ),
            );
        } else if (frame.type === "event") {
          if (frame.event === "connect.challenge" && !challenged) {
            challenged = true;
            this.request("connect", gatewayHandshake(this.token))
              .then((hello) => {
                if (hello?.protocol !== 4) throw gatewayError("PROTOCOL_MISMATCH");
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
    this.rejectPending();
    if (this.ws) {
      this.ws.removeAllListeners("message");
      this.ws.terminate();
      this.ws = null;
    }
  }
}
