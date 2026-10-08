import http from "node:http";
import https from "node:https";
import net from "node:net";
import { assertAllowedAddresses, policyLookup } from "./endpoint-address.js";

/** Response headers beyond this size end the request (independent of Node's CLI flag). */
const MAX_HEADER_BYTES = 16 * 1024;

/**
 * A transport failure tagged with the adapter's error kind: `"timeout"` only for the idle
 * timer, `"network"` for disconnects, aborts and socket failures. Messages are fixed text,
 * so neither keys nor upstream content can reach them.
 */
export const transportError = (kind, message) =>
  Object.assign(new Error(message), { adapterKind: kind });

const asTransport = (error, message) =>
  error?.adapterKind ? error : transportError("network", message);

/** Yields the response text; every chunk resets the idle timer. */
async function* streamChunks(response, idle) {
  let finished = false;
  try {
    for await (const chunk of response) {
      idle();
      yield chunk;
    }
    finished = true;
  } catch (error) {
    throw asTransport(error, "upstream stream failed");
  } finally {
    // A consumer that stops early releases the socket instead of returning it unread.
    if (!finished) response.destroy();
  }
}

async function readText(response, limitBytes, idle) {
  let text = "";
  let size = 0;
  for await (const chunk of streamChunks(response, idle)) {
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
 * are returned as plain statuses and no proxy is used.
 */
export function createUpstreamClient({ baseUrl, lookup, maxSockets = 32 }) {
  const base = new URL(baseUrl);
  // Only http(s) is allowed; any other scheme fails the policy as an unusable address.
  if (base.protocol !== "http:" && base.protocol !== "https:")
    assertAllowedAddresses([{ address: "" }], base.protocol);
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
    lookup: policyLookup(base.protocol, lookup),
  });
  // Close handlers of requests whose response is not finished (also unread responses).
  const active = new Set();
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
    const url = target(path);
    if (!url)
      return Promise.reject(transportError("network", "upstream path not allowed"));
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let req = null;
      let response = null;
      let timer;
      // Transport errors stay in the adapter process; they are not browser problems.
      const destroyWith = (error) => (response ?? req)?.destroy(error);
      const idle = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () => destroyWith(transportError("timeout", "upstream idle timeout")),
          idleTimeoutMs,
        );
      };
      const abortError = () =>
        signal.reason?.adapterKind
          ? signal.reason
          : transportError("network", "upstream request aborted");
      const onAbort = () => destroyWith(abortError());
      const onClose = () =>
        destroyWith(transportError("network", "upstream client closed"));
      const cleanup = () => {
        clearTimeout(timer);
        active.delete(onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      if (signal?.aborted) return reject(abortError());
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
        // Node validates header values synchronously and its message may echo them (the key).
        return reject(transportError("network", "invalid upstream request"));
      }
      req.on("error", (error) => {
        cleanup();
        reject(asTransport(error, "upstream connection failed"));
      });
      req.on("response", (res) => {
        response = res;
        res.setEncoding("utf8");
        // Failures surface through `chunks`/`text()`; an unread response must not throw.
        res.on("error", () => {});
        res.on("close", cleanup);
        idle();
        resolve({
          status: res.statusCode,
          headers: res.headers,
          chunks: streamChunks(res, idle),
          text: (limitBytes) => readText(res, limitBytes, idle),
        });
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      active.add(onClose);
      idle();
      req.end(payload);
    });
  }

  function close() {
    for (const onClose of [...active]) onClose();
    agent.destroy();
  }

  return { request, close };
}
