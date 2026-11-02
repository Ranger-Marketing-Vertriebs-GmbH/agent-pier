import http from "node:http";
import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { privateDirectory, readJSON, writePrivate } from "../../lib/storage.js";

// AgentPier's loopback proxy for the logins it holds (ChatGPT, MCP OAuth): runtimes
// never get the real tokens, only a credential for this proxy, which injects the
// current token on the way out and renews it when the upstream rejects it. It has a
// listener of its own on 127.0.0.1, never AgentPier's web port, so remote access
// cannot reach it; its port stays the same across restarts, as compiled runtime
// configurations name it.
//
// A credential is `apx1.<scope>.<mac>`: the scope (base64url of a JSON array, e.g.
// ["chatgpt", agentId, profileId] or ["mcp", serverId]) and its HMAC-SHA256 under the
// proxy's own key. It works only against this proxy and only for its scope; a new
// key (rotate) revokes every credential at once.

const prefix = "apx1";
const maxBody = 32 * 1024 * 1024;

/** A JSON error the runtimes read as an HTTP failure; never an upstream body. */
export function proxyError(res, status, code, message, extra = {}) {
  if (res.headersSent) return res.destroy();
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extra,
  });
  res.end(JSON.stringify({ error: { code, message, type: code } }));
}

/** The request body, at most 32 MiB (a Codex request with images stays far below). */
export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBody) throw Object.assign(Error("too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// Headers that describe one hop, or that the proxy sets itself.
const hopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
]);

/** `headers` without hop-by-hop ones and without `drop` (lower-case names). */
export function forwardHeaders(headers, drop = []) {
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (hopHeaders.has(key) || drop.includes(key) || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export class RuntimeProxy {
  #routes = new Map();
  #starting = null;
  constructor({ dataDir, warn = console.warn }) {
    this.file = path.join(dataDir, "model-logins", "proxy.json");
    this.warn = warn;
    const saved = readJSON(this.file, null);
    const valid =
      saved && /^[a-f0-9]{64}$/.test(saved.key) && Number.isInteger(saved.port ?? 0);
    this.key = valid ? saved.key : randomBytes(32).toString("hex");
    this.savedPort = valid && saved.port > 0 && saved.port < 65536 ? saved.port : 0;
    if (!valid) this.#persist(this.savedPort);
  }
  #persist(port) {
    privateDirectory(path.dirname(this.file));
    writePrivate(this.file, { key: this.key, port });
  }
  /** Handles `/<name>/…` with `handler(req, res, { scope, rest })` once authorised. */
  route(name, handler) {
    this.#routes.set(name, handler);
  }
  /** The credential of `scope` (an array of strings). Pure for a given key. */
  credential(scope) {
    const body = Buffer.from(JSON.stringify(scope)).toString("base64url");
    const mac = createHmac("sha256", this.key)
      .update(`${prefix}.${body}`)
      .digest("base64url");
    return `${prefix}.${body}.${mac}`;
  }
  /** The scope of a valid `Authorization: Bearer <credential>`, else null. */
  verify(authorization) {
    const match = /^Bearer (apx1\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{43})$/.exec(
      String(authorization || ""),
    );
    if (!match) return null;
    const [, body, mac] = match[1].split(".");
    const expected = createHmac("sha256", this.key)
      .update(`${prefix}.${body}`)
      .digest("base64url");
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const scope = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      return Array.isArray(scope) && scope.every((s) => typeof s === "string")
        ? scope
        : null;
    } catch {
      return null;
    }
  }
  /** A new key: every credential handed out so far stops working. */
  rotate() {
    this.key = randomBytes(32).toString("hex");
    this.#persist(this.port || this.savedPort);
  }
  /** Listens (once) and resolves the proxy's base URL `http://127.0.0.1:<port>`. */
  start() {
    this.#starting ??= this.#listen().catch((error) => {
      this.#starting = null;
      throw error;
    });
    return this.#starting;
  }
  async #listen() {
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch(() =>
        proxyError(res, 502, "proxy_failed", "Proxy failed."),
      );
    });
    // Streams (SSE) run as long as a model turn; idle sockets still end.
    server.requestTimeout = 0;
    server.headersTimeout = 30_000;
    const listen = (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    try {
      await listen(this.savedPort);
    } catch (error) {
      // The saved port is taken: a new one (the next apply compiles it).
      if (!this.savedPort || error.code !== "EADDRINUSE") throw error;
      this.warn("AgentPier's runtime proxy moved to a new port.");
      await listen(0);
    }
    this.server = server;
    this.port = server.address().port;
    if (this.port !== this.savedPort) this.#persist((this.savedPort = this.port));
    return (this.url = `http://127.0.0.1:${this.port}`);
  }
  async #handle(req, res) {
    // A browser page never reaches the proxy (DNS rebinding, cross-site requests).
    if (req.headers.origin || req.headers["sec-fetch-site"])
      return proxyError(res, 403, "forbidden", "Not for browsers.");
    const url = new URL(req.url, "http://127.0.0.1");
    const [, name, ...rest] = url.pathname.split("/");
    const handler = this.#routes.get(name);
    if (!handler) return proxyError(res, 404, "not_found", "Unknown route.");
    const scope = this.verify(req.headers.authorization);
    if (!scope || scope[0] !== name)
      return proxyError(res, 401, "invalid_credential", "Invalid AgentPier credential.");
    return handler(req, res, { scope, rest: rest.join("/"), search: url.search });
  }
  async close() {
    const server = this.server;
    this.server = null;
    this.#starting = null;
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}
