import http from "node:http";
import { randomUUID } from "node:crypto";
import { createTranslator } from "../protocol-adapter/translate.js";
import { resolveCapabilities } from "../protocol-adapter/capabilities.js";
import { authHeaders } from "../providers/endpoint-http.js";
import { createUpstreamClient } from "../providers/endpoint-stream.js";
import { createAdapterCounters } from "./adapter-counters.js";
import {
  bodyLimitMessage,
  clientError,
  hostAllowed,
  readBody,
  requestPath,
  requestCounterName,
  routeFor,
  tokenMatches,
  writeRendered,
} from "./adapter-http.js";
import { handleInference } from "./adapter-request.js";
import { createRetry } from "./adapter-retry.js";
import { createDiagnosticsWriter } from "./adapter-diagnostics.js";

/** Largest accepted client request body (Codex sends large requests). */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

/**
 * The adapter's loopback HTTP server for one session: token auth, per-client path
 * routing, one translator exchange per request and diagnostics counters. `ctx` is the
 * shared per-session context: `ctx.retry` is the capability retry, `ctx.onDone` schedules
 * the throttled diagnostics write after every request (unauthorized ones included).
 */
export function createAdapterServer(config, options = {}) {
  const {
    keepaliveMs = 15_000,
    idleTimeoutMs = 240_000,
    maxBodyBytes = MAX_REQUEST_BODY_BYTES,
    lookup,
    now = Date.now,
    restarts = 0,
  } = options;
  const client = config.clientProtocol;
  const upstream = config.upstreamProtocol;
  const secrets = [config.upstream.apiKey, config.token].filter(Boolean);
  const translator = createTranslator({
    client,
    upstream,
    model: config.model,
    capabilities: config.capabilities,
    thinkTagExtraction: config.thinkTagExtraction,
    sessionKey: randomUUID(),
    secrets,
  });
  const capabilities = resolveCapabilities(upstream, config.capabilities);
  const counters = createAdapterCounters();
  const upstreamClient = createUpstreamClient({
    baseUrl: config.upstream.baseUrl,
    lookup,
  });
  const startedAt = new Date(now()).toISOString();
  const ctx = {
    client,
    upstream,
    translator,
    upstreamClient,
    secrets,
    counters,
    now,
    upstreamAuth: authHeaders(config.upstream.apiKey, config.upstream.authHeader),
    timing: { keepaliveMs, idleTimeoutMs },
    capabilities,
    keepalives: new Set(),
    // Abort functions of in-flight inference requests (shutdown aborts them).
    requests: new Set(),
    closing: false,
    setCapability(name, value) {
      translator.setCapability(name, value);
      capabilities[name] = value;
    },
    onDone: () => {},
  };
  ctx.retry = createRetry(ctx);

  let port = null;

  /** Answers without reading the body and closes the connection afterwards. */
  function refuse(res, kind, message) {
    res.setHeader("connection", "close");
    writeRendered(res, clientError(client, kind, message));
  }

  async function dispatch(req, res) {
    if (!hostAllowed(req.headers, port)) {
      counters.increment("forbidden");
      return refuse(res, "permission", "request not allowed");
    }
    const pathname = requestPath(req.url);
    const route =
      pathname === null ? "malformed" : routeFor(client, req.method, pathname);
    // Claude Code's probe answers before auth; it carries no token.
    if (route === "hello" && req.method === "HEAD") return void res.writeHead(200).end();
    if (!tokenMatches(config.token, req.headers)) {
      counters.increment("unauthorized");
      return refuse(res, "auth", "invalid adapter token");
    }
    if (route === "hello") return void res.writeHead(200).end();
    counters.count("requests", requestCounterName(client, pathname));
    if (route === "malformed")
      return refuse(res, "invalidRequest", "malformed request target");
    // count_tokens included: never forwarded, Claude Code then estimates locally.
    if (route !== "inference") return refuse(res, "notFound", "not found");
    const raw = await readBody(req, maxBodyBytes);
    if (raw === null)
      return refuse(res, "invalidRequest", bodyLimitMessage(maxBodyBytes));
    await handleInference(ctx, req, res, raw);
  }

  // Handlers in flight: close() lets them settle (and count) before the final write.
  const pending = new Set();
  const server = http.createServer((req, res) => {
    const handling = handle(req, res);
    pending.add(handling);
    const settled = () => pending.delete(handling);
    handling.then(settled, settled);
  });

  async function handle(req, res) {
    try {
      await dispatch(req, res);
    } catch (error) {
      if (error?.clientAborted) counters.increment("clientDisconnects");
      else {
        counters.count("errors", "adapter.internal");
        if (!res.headersSent)
          writeRendered(res, clientError(client, "server", "adapter error"));
        else res.destroy();
      }
    } finally {
      ctx.onDone();
    }
  }
  // The process never writes to stdout/stderr; malformed client requests just close.
  server.on("clientError", (_error, socket) => socket.destroy());

  function snapshot() {
    const t = translator.diagnostics();
    const c = counters.snapshot();
    return {
      version: 1,
      startedAt,
      updatedAt: new Date(now()).toISOString(),
      route: { client, upstream },
      restarts,
      requests: c.requests,
      unauthorized: c.unauthorized,
      upstreamStatus: c.upstreamStatus,
      errors: { ...t.errors, ...c.errors },
      forbidden: c.forbidden,
      clientDisconnects: c.clientDisconnects,
      shutdownAborts: c.shutdownAborts,
      dropped: t.dropped,
      adjustments: t.adjustments,
      compactionDropped: t.dropped["input.compaction"] ?? 0,
      capabilityFallbacks: c.capabilityFallbacks,
      capabilities: { ...capabilities },
      estimatedUsage: t.estimatedUsage,
      cacheReadTokens: t.cacheReadTokens ?? 0,
    };
  }

  const writer = createDiagnosticsWriter({
    path: config.diagnosticsPath,
    snapshot,
    now,
  });
  ctx.onDone = () => writer.touch();

  return {
    ctx,
    snapshot,
    /** Binds 127.0.0.1 only; resolves the bound port. */
    listen: (requested = 0) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(requested, "127.0.0.1", () => {
          server.off("error", reject);
          port = server.address().port;
          resolve(port);
        });
      }),
    /**
     * Ends open client streams and upstream requests; resolves once all sockets closed,
     * the aborted handlers settled and the final diagnostics were written (later touches
     * are ignored).
     */
    close: async () => {
      await new Promise((resolve) => {
        ctx.closing = true;
        for (const stop of [...ctx.keepalives]) stop();
        for (const abort of [...ctx.requests]) abort("shutdown");
        server.close(() => resolve());
        server.closeAllConnections();
        upstreamClient.close();
      });
      await Promise.allSettled([...pending]);
      await writer.flush();
    },
  };
}
