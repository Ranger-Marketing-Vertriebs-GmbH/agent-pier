import http from "node:http";
import https from "node:https";
import net from "node:net";
import {
  assertAllowedAddresses,
  assertAllowedProtocol,
  policyLookup,
} from "./endpoint-address.js";

/** Response headers beyond this size end the request (independent of Node's CLI flag). */
const MAX_HEADER_BYTES = 16 * 1024;
/** Socket errors that mean a pooled connection was closed by the upstream while idle. */
const STALE_SOCKET = new Set(["ECONNRESET", "EPIPE"]);

/**
 * A transport failure tagged with the adapter's error kind: `"timeout"` only for the idle
 * timer, `"network"` for disconnects, aborts and socket failures. Messages are fixed text,
 * so neither keys nor upstream content can reach them.
 */
export const transportError = (kind, message) =>
  Object.assign(new Error(message), { adapterKind: kind });

const asTransport = (error, message) =>
  error?.adapterKind ? error : transportError("network", message);

/**
 * Yields the response text. The idle timer runs only while the consumer waits for the next
 * chunk (and restarts on every upstream byte), so a slow consumer is never reported as an
 * upstream timeout.
 */
async function* streamChunks(response, timer) {
  let finished = false;
  try {
    for await (const chunk of response) {
      timer.hold();
      yield chunk;
      timer.arm();
    }
    finished = true;
  } catch (error) {
    throw asTransport(error, "upstream stream failed");
  } finally {
    // A consumer that stops early releases the socket instead of returning it unread.
    if (!finished) response.destroy();
  }
}

async function readText(response, limitBytes, timer) {
  let text = "";
  let size = 0;
  for await (const chunk of streamChunks(response, timer)) {
    size += Buffer.byteLength(chunk);
    if (size > limitBytes) {
      const error = transportError("network", "upstream response too large");
      response.destroy(error);
      throw error;
    }
    text += chunk;
  }
  return text;
}

/**
 * Streaming POST client for one configured upstream origin. Its keep-alive agent resolves
 * the host through `policyLookup` for every new socket, so the endpoint address policy is
 * re-checked per connection (no launch-time pinning); TLS verifies the hostname, redirects
 * are returned as plain statuses and no proxy is used. Every response must be consumed
 * with `chunks` or `text()`, or released with `cancel()`.
 */
export function createUpstreamClient({
  baseUrl,
  lookup,
  maxSockets = 32,
  freeSocketTimeoutMs = 30_000,
}) {
  const base = new URL(baseUrl);
  assertAllowedProtocol(base.protocol);
  const secure = base.protocol === "https:";
  const hostname = base.hostname.replace(/^\[|\]$/g, "");
  if (net.isIP(hostname))
    assertAllowedAddresses(
      [{ address: hostname, family: net.isIP(hostname) }],
      base.protocol,
    );
  const client = secure ? https : http;
  const agent = new client.Agent({
    keepAlive: true,
    maxSockets,
    scheduling: "lifo",
    autoSelectFamily: true,
    // Pooled sockets idle longer than this are closed instead of going stale.
    timeout: freeSocketTimeoutMs,
    lookup: policyLookup(base.protocol, lookup),
  });
  // Close handlers of requests whose response is not finished (also unread responses).
  const active = new Set();
  let closed = false;
  const prefix = `${base.origin}${base.pathname.replace(/\/+$/, "")}`;

  /** Resolves `path` below the base URL; anything leaving the origin is refused. */
  function target(path) {
    if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//"))
      return null;
    try {
      const url = new URL(`${prefix}${path}`);
      return url.origin === base.origin && !url.username && !url.password ? url : null;
    } catch {
      return null;
    }
  }

  function request({ path, body, headers = {}, signal, idleTimeoutMs = 240_000 }) {
    if (closed)
      return Promise.reject(transportError("network", "upstream client closed"));
    const url = target(path);
    if (!url)
      return Promise.reject(transportError("network", "upstream path not allowed"));
    const payload = JSON.stringify(body);
    if (typeof payload !== "string")
      return Promise.reject(new TypeError("upstream request body must be JSON"));
    return new Promise((resolve, reject) => {
      let req = null;
      let socket = null;
      let response = null;
      let handle;
      let armed = false;
      // Transport errors stay in the adapter process; they are not browser problems.
      const destroyWith = (error) => (response ?? req)?.destroy(error);
      const timer = {
        arm() {
          armed = true;
          clearTimeout(handle);
          handle = setTimeout(
            () => destroyWith(transportError("timeout", "upstream idle timeout")),
            idleTimeoutMs,
          );
        },
        hold() {
          armed = false;
          clearTimeout(handle);
        },
      };
      const onBytes = () => armed && timer.arm();
      const abortError = () =>
        signal.reason?.adapterKind
          ? signal.reason
          : transportError("network", "upstream request aborted");
      const onAbort = () => destroyWith(abortError());
      const onClose = () =>
        destroyWith(transportError("network", "upstream client closed"));
      const cleanup = () => {
        timer.hold();
        socket?.off("data", onBytes);
        active.delete(onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal?.aborted) return reject(abortError());

      const send = (retry) => {
        try {
          req = client.request(url, {
            method: "POST",
            agent,
            maxHeaderSize: MAX_HEADER_BYTES,
            headers: {
              "content-type": "application/json",
              ...headers,
              "content-length": Buffer.byteLength(payload),
            },
            ...(secure && !net.isIP(hostname) ? { servername: hostname } : {}),
          });
        } catch {
          // Node validates header values synchronously; its message may echo the key.
          cleanup();
          return reject(transportError("network", "invalid upstream request"));
        }
        const current = req;
        current.on("socket", (s) => {
          socket = s;
          s.on("data", onBytes);
        });
        current.on("error", (error) => {
          socket?.off("data", onBytes);
          // A pooled socket the upstream closed while idle fails before any answer;
          // the request never reached the upstream, so it is sent once more.
          if (retry && current.reusedSocket && !response && STALE_SOCKET.has(error.code))
            return send(false);
          cleanup();
          reject(asTransport(error, "upstream connection failed"));
        });
        current.on("response", (res) => {
          response = res;
          res.setEncoding("utf8");
          // Failures surface through `chunks`/`text()`; an unread response must not throw.
          res.on("error", () => {});
          res.on("end", () => socket?.off("data", onBytes));
          res.on("close", cleanup);
          timer.arm();
          resolve({
            status: res.statusCode,
            headers: res.headers,
            chunks: streamChunks(res, timer),
            text: (limitBytes) => readText(res, limitBytes, timer),
            // Releases a response the caller does not read; its socket is not reused.
            cancel: () => res.destroy(),
          });
        });
        current.end(payload);
      };

      signal?.addEventListener("abort", onAbort, { once: true });
      active.add(onClose);
      timer.arm();
      send(true);
    });
  }

  function close() {
    closed = true;
    for (const onClose of [...active]) onClose();
    agent.destroy();
  }

  return { request, close };
}
