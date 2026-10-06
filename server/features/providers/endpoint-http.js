import http from "node:http";
import https from "node:https";
import net from "node:net";
import { resolveEndpointTarget } from "./endpoint-address.js";

const LIMIT = 1024 * 1024;
const DEFAULT_TIMEOUT = 10_000;

/** Errors carry only a stable reason; response bodies never reach messages. */
const tagged = (reason) => Object.assign(new Error(reason), { reason });
/** A signal that expired through AbortSignal.timeout is a timeout, not a cancellation. */
const abortReason = (signal) =>
  tagged(signal.reason?.name === "TimeoutError" ? "timeout" : "aborted");

export function authHeaders(apiKey, authHeader) {
  if (!apiKey) return {};
  return authHeader ? { [authHeader]: apiKey } : { Authorization: `Bearer ${apiKey}` };
}

function parseTarget(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed;
  } catch {
    /* Unparseable URLs are rejected below. */
  }
  throw tagged("notAllowed");
}

/**
 * Sends one request to the addresses that passed the endpoint URL rule. The resolved
 * addresses are pinned through a custom lookup, so DNS cannot change between the check and
 * the connection, while Host, SNI and certificate checks keep using the hostname.
 * Redirects are returned as plain statuses and bodies are capped at 1 MB.
 */
export async function endpointRequest({
  url,
  method = "GET",
  headers = {},
  body,
  timeoutMs = DEFAULT_TIMEOUT,
  signal,
  lookup,
}) {
  const parsed = parseTarget(url);
  if (signal?.aborted) throw abortReason(signal);
  const secure = parsed.protocol === "https:";
  const client = secure ? https : http;
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let request;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        request?.destroy();
        reject(error);
      } else resolve(value);
    };
    // The timer and abort listener cover the DNS phase too: a stalled lookup cannot be
    // cancelled, but the request settles on time and ignores its late result.
    const onAbort = () => finish(abortReason(signal));
    const timer = setTimeout(() => finish(tagged("timeout")), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    const start = (target) =>
      client.request(
        parsed,
        {
          method,
          agent: false,
          headers: {
            Accept: "application/json",
            ...(payload === undefined
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": Buffer.byteLength(payload),
                }),
            ...headers,
          },
          // Every checked address is offered, so the connection falls back between
          // them (for example ::1 then 127.0.0.1 for localhost).
          autoSelectFamily: true,
          lookup: (_hostname, options, callback) =>
            options?.all
              ? callback(null, target.addresses)
              : callback(null, target.address, target.family),
          ...(secure && !net.isIP(target.hostname)
            ? { servername: target.hostname }
            : {}),
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("error", () => finish(tagged("network")));
          response.on("close", () => {
            if (!response.complete) finish(tagged("network"));
          });
          if (Number(response.headers["content-length"]) > LIMIT) {
            finish(tagged("tooLarge"));
            return;
          }
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > LIMIT) finish(tagged("tooLarge"));
            else chunks.push(chunk);
          });
          response.on("end", () => {
            let json = null;
            try {
              json = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            } catch {
              json = null;
            }
            finish(null, { status: response.statusCode, json });
          });
        },
      );
    const send = (target) => {
      if (settled) return;
      try {
        request = start(target);
      } catch {
        // Node validates header values synchronously; only the key can carry
        // characters it refuses, so the error text (which may echo it) is dropped.
        finish(tagged("invalidKey"));
        return;
      }
      request.on("error", () => finish(tagged("network")));
      if (payload !== undefined) request.write(payload);
      request.end();
    };
    resolveEndpointTarget(parsed.href, lookup ? { lookup } : {}).then(send, (error) =>
      // An unresolvable host is a reachability failure, not a policy refusal.
      finish(tagged(error.reason === "network" ? "network" : "notAllowed")),
    );
  });
}
