import express from "express";
import { rateLimit } from "express-rate-limit";
import { problem } from "../lib/storage.js";
import { secretMatches } from "../features/assistants/agent-hook-store.js";
import { hookEligible } from "../features/assistants/agent-hook-rights.js";

// The public machine endpoint of agent hooks: `POST /hooks/<hookId>` on AgentPier's
// own port, mounted before `authorizeRequest`. Senders are machines (Zabbix, CI):
// a Bearer secret per hook, no browser, no Funnel, no query token. Error codes are
// machine codes and are not localized.
export const hookPath = /^\/hooks\/([0-9a-f-]{36})$/;
const maxBody = 65536;
const bodyTimeout = 15000;
const loopbackAddresses = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

/**
 * The host branch a hook request arrived on: `local` (loopback, local host, no proxy
 * markers), `tailscale` (loopback from Tailscale Serve on the configured remote host;
 * no identity needed, tagged nodes send none) or `network` (network mode host without
 * Tailscale markers). Browsers, Funnel and query tokens are refused with 403.
 */
export function authorizeHookTransport(req, config) {
  const headers = req.headers;
  if (headers["tailscale-funnel-request"] !== undefined)
    throw problem("Hooks are not reachable through Tailscale Funnel.", 403);
  if (headers.origin !== undefined || headers["sec-fetch-site"] !== undefined)
    throw problem("Hooks do not accept browser requests.", 403);
  if (new URL(req.url || "/", "http://hook").searchParams.has("token"))
    throw problem("Hook secrets are accepted only in the Authorization header.", 403);
  const host = headers.host;
  const loopback = loopbackAddresses.includes(req.socket.remoteAddress);
  const local = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const names = Object.keys(headers);
  const tailscaleMarkers = names.some((key) => key.startsWith("tailscale-"));
  if (loopback && local.has(host)) {
    // Serve preserves Host: proxy markers never enter the local branch.
    if (
      tailscaleMarkers ||
      names.some((key) => key.startsWith("x-forwarded-") || key === "forwarded")
    )
      throw problem("Proxy requests require the configured remote host.", 403);
    return "local";
  }
  if (loopback && config.remoteUrl && new URL(config.remoteUrl).host === host)
    return "tailscale";
  if (config.network?.enabled && config.networkHosts?.has(host)) {
    if (tailscaleMarkers)
      throw problem("Proxy requests require the configured remote host.", 403);
    return "network";
  }
  throw problem("Hooks require the local, Tailscale or configured network host.", 403);
}

// The windows no flood may evict: the local machine's and the shared tailnet
// window, for scans and per hook (one per stored hook at most).
const fixed = (key) => /^(local|tailscale)(\|[0-9a-f-]{36})?$/.test(key);

/**
 * Failed authentication per source key: `limit` failures in `windowMs` block it. A
 * request counts against every key of its source (`keys` may be one or a list). At
 * most `maxKeys` windows are kept: expired ones are pruned at most once per
 * `pruneMs`, then the least recently failed key is evicted, never a fixed one.
 */
export class AuthThrottle {
  constructor({
    now = Date.now,
    limit = 10,
    windowMs = 600000,
    maxKeys = 1000,
    pruneMs = 60000,
  } = {}) {
    Object.assign(this, { now, limit, windowMs, maxKeys, pruneMs });
    this.failures = new Map();
    this.prunedAt = -Infinity;
  }
  recent(key) {
    const since = this.now() - this.windowMs;
    const kept = (this.failures.get(key) || []).filter((at) => at > since);
    if (!kept.length) this.failures.delete(key);
    return kept;
  }
  /** Milliseconds until the source may try again; 0 when it is free. */
  blocked(keys) {
    let wait = 0;
    for (const key of [keys].flat()) {
      const kept = this.recent(key);
      if (kept.length >= this.limit)
        wait = Math.max(
          wait,
          kept[kept.length - this.limit] + this.windowMs - this.now(),
        );
    }
    return wait;
  }
  fail(keys) {
    for (const key of [keys].flat()) {
      // Only the last `limit` failures decide; re-inserting keeps the map in
      // least-recently-failed order.
      const kept = [...this.recent(key), this.now()].slice(-this.limit);
      this.failures.delete(key);
      if (this.failures.size >= this.maxKeys) this.makeRoom();
      this.failures.set(key, kept);
    }
  }
  makeRoom() {
    if (this.now() - this.prunedAt >= this.pruneMs) {
      this.prunedAt = this.now();
      for (const key of [...this.failures.keys()]) this.recent(key);
    }
    for (const key of this.failures.keys()) {
      if (this.failures.size < this.maxKeys) return;
      if (!fixed(key)) this.failures.delete(key);
    }
  }
}

// The throttle keys of a request's source. Tailscale Serve proxies every tailnet
// device from loopback and a local process can forge X-Forwarded-For, so every
// Tailscale-branch request also counts against one shared tailnet window: rotating
// forged addresses never escapes it (as login.js does for sign-ins). Scans (404 of a
// well-formed id) count against these keys; a wrong secret counts against the same
// keys of that one hook only (`authKeys`), so a sender still using an old secret
// after Regenerate secret blocks neither other hooks nor other sources.
function sourceKeys(req, branch) {
  if (branch === "local") return ["local"];
  if (branch === "tailscale") {
    const forwarded = String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim();
    return [`tailscale:${forwarded || "unknown"}`, "tailscale"];
  }
  return [`network:${req.socket.remoteAddress}`];
}
const authKeys = (keys, hookId) => keys.map((key) => `${key}|${hookId}`);

// The enabled hook of an eligible agent, else null (one 404 for every case).
function liveHook(hooks, hookId) {
  const hook = hooks?.store.get(hookId);
  if (!hook) return { hook: null, live: false };
  let agent = null;
  try {
    agent = hooks.assistants.store.getAssistant(hook.assistantId);
  } catch {
    agent = null;
  }
  return { hook, live: !!hook.enabled && !!agent && hookEligible(agent) };
}

const mediaType = (value) =>
  String(value || "")
    .split(";")[0]
    .trim()
    .toLowerCase();

// The body up to the cap; past it the rest is drained and only counted. The whole
// body must arrive within the request timeout.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => {
      req.destroy();
      reject(problem("The hook body timed out.", 408));
    }, bodyTimeout);
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= maxBody) chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      resolve({ size, buffer: size <= maxBody ? Buffer.concat(chunks) : null });
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * The middleware for `/hooks/…`: method, transport, auth throttle, hook lookup,
 * secret, content type and body size are checked here; everything else is
 * `AgentHooks.deliver`. Refusals of a stored hook are audited (never payload,
 * headers or secret); requests without a stored hook cannot name an agent.
 */
export function hookEndpoint(
  services,
  effective,
  { throttle = new AuthThrottle(), requestLimit = 600 } = {},
) {
  const isHookRequest = (req) => req.path === "/hooks" || req.path.startsWith("/hooks/");
  // A request ceiling in front of every check: one window per stored hook and one
  // shared window for everything else, so the key count stays bounded by the stored
  // hooks and a flood of unknown IDs never fills a real hook's window.
  const requests = rateLimit({
    windowMs: 60_000,
    limit: requestLimit,
    skip: (req) => !isHookRequest(req),
    keyGenerator: (req) => {
      const id = hookPath.exec(req.path)?.[1];
      return id && services.assistantRoutines?.hooks?.store.get(id) ? id : "unknown";
    },
    standardHeaders: "draft-8",
    legacyHeaders: false,
    handler: (_req, res) => res.status(429).json({ error: "HOOK_RATE_LIMITED" }),
  });
  const router = express.Router();
  router.use(requests, async (req, res, next) => {
    if (!isHookRequest(req)) return next();
    const reply = (status, body, headers = {}) => {
      for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
      res.status(status).json(body);
    };
    if (req.method !== "POST")
      return reply(405, { error: "HOOK_METHOD_NOT_ALLOWED" }, { Allow: "POST" });
    let branch;
    try {
      branch = authorizeHookTransport(req, effective());
    } catch {
      return reply(403, { error: "HOOK_FORBIDDEN" });
    }
    req.setTimeout(bodyTimeout, () => req.destroy());
    const limited = (keys) => {
      const wait = throttle.blocked(keys);
      if (wait > 0)
        reply(
          429,
          { error: "HOOK_RATE_LIMITED" },
          { "Retry-After": String(Math.ceil(wait / 1000)) },
        );
      return wait > 0;
    };
    const key = sourceKeys(req, branch);
    if (limited(key)) return;
    const hooks = services.assistantRoutines?.hooks;
    const match = hookPath.exec(req.path);
    const { hook, live } = match ? liveHook(hooks, match[1]) : { hook: null };
    const refuse = (status, error, outcome, size = 0) => {
      if (hook) hooks.refused(hook, { outcome, branch, size });
      reply(status, { error });
    };
    if (!live) {
      if (match) throttle.fail(key);
      return refuse(404, "HOOK_NOT_FOUND", "not-found");
    }
    // Checked before the secret: while a hook's window from this source is full,
    // its right secret from there waits as well.
    const hookKey = authKeys(key, hook.id);
    if (limited(hookKey)) return;
    const authorization = req.headers.authorization;
    const supplied =
      typeof authorization === "string" && /^Bearer \S+$/i.test(authorization)
        ? authorization.slice(7)
        : null;
    if (!secretMatches(hook.secretHash, supplied)) {
      throttle.fail(hookKey);
      return refuse(401, "HOOK_UNAUTHORIZED", "unauthorized");
    }
    const contentType = mediaType(req.headers["content-type"]);
    if (contentType !== "application/json" && contentType !== "text/plain")
      return refuse(415, "HOOK_UNSUPPORTED_TYPE", "invalid");
    // A declared body over the cap is refused before it is read.
    const declared = Number(req.headers["content-length"]);
    if (Number.isSafeInteger(declared) && declared > maxBody)
      return refuse(413, "HOOK_TOO_LARGE", "too-large", declared);
    let body;
    try {
      body = await readBody(req);
    } catch {
      return;
    }
    if (!body.buffer) return refuse(413, "HOOK_TOO_LARGE", "too-large", body.size);
    const text = body.buffer.toString("utf8");
    let json;
    if (!text.trim()) return refuse(400, "HOOK_INVALID_BODY", "invalid", body.size);
    if (contentType === "application/json") {
      try {
        json = JSON.parse(text);
      } catch {
        return refuse(400, "HOOK_INVALID_BODY", "invalid", body.size);
      }
    }
    // Only the event-id headers reach deliver; authorization and the rest stay here.
    const headers = {};
    for (const name of ["idempotency-key", "x-event-id"])
      if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
    try {
      const { status, body: answer } = await hooks.deliver(hook, {
        text,
        json,
        contentType,
        size: body.size,
        headers,
        source: branch,
      });
      reply(status, answer, status === 503 ? { "Retry-After": "30" } : {});
    } catch (error) {
      console.error("Agent hook delivery failed:", error?.message);
      reply(503, { error: "HOOK_UNAVAILABLE" }, { "Retry-After": "30" });
    }
  });
  return router;
}
