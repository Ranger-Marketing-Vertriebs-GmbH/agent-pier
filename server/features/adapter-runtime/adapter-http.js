import { timingSafeEqual } from "node:crypto";
import { messagesErrorBody, responsesErrorBody } from "../protocol-adapter/errors.js";

const MIB = 1024 * 1024;

/**
 * True when `x-api-key` or `Authorization: Bearer` carries the session token. The token
 * is random with a fixed length, so a length mismatch reveals nothing secret; equal
 * lengths are compared in constant time.
 */
export function tokenMatches(expected, headers) {
  if (typeof expected !== "string" || expected === "") return false;
  const wanted = Buffer.from(expected);
  const bearer = /^Bearer\s+(\S+)\s*$/i.exec(headers.authorization ?? "")?.[1];
  const candidates = [headers["x-api-key"], bearer].filter((v) => typeof v === "string");
  let ok = false;
  for (const candidate of candidates) {
    const given = Buffer.from(candidate);
    ok = (given.length === wanted.length && timingSafeEqual(given, wanted)) || ok;
  }
  return ok;
}

/**
 * Defense in depth against DNS rebinding and browsers: the Host header must name the
 * loopback listener (`127.0.0.1`, `localhost` or `[::1]` with the bound port), and no
 * request may carry an `Origin` header (the CLIs never send one; browsers always do on
 * cross-origin requests).
 */
export function hostAllowed(headers, port) {
  if (headers.origin !== undefined) return false;
  const host = String(headers.host ?? "").toLowerCase();
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host);
}

/**
 * Pathname of an origin-form request target (`/path?query`), or null for anything else
 * (absolute form, `//authority`, `*`, unparseable).
 */
export function requestPath(url) {
  if (typeof url !== "string" || !url.startsWith("/") || url.startsWith("//"))
    return null;
  try {
    return new URL(url, "http://adapter.invalid").pathname;
  } catch {
    return null;
  }
}

/** Which handler serves a request; the query string never affects routing. */
export function routeFor(client, method, pathname) {
  // /api/hello is Claude Code's connection probe; the Responses client has no such path.
  if (
    client === "messages" &&
    pathname === "/api/hello" &&
    (method === "GET" || method === "HEAD")
  )
    return "hello";
  if (method !== "POST") return "notFound";
  if (client === "messages")
    return pathname === "/v1/messages" ? "inference" : "notFound";
  return pathname === "/responses" || pathname === "/v1/responses"
    ? "inference"
    : "notFound";
}

/**
 * Paths counted under their own name in `requests`; everything else counts as `"other"`.
 * Claude Code's `count_tokens` is answered 404 (it then estimates locally) but counted
 * separately so its share of the traffic stays visible.
 */
export function requestCounterName(client, pathname) {
  const known =
    client === "messages"
      ? ["/v1/messages", "/v1/messages/count_tokens"]
      : ["/responses", "/v1/responses"];
  return known.includes(pathname) ? pathname : "other";
}

/** Adapter-local client error in the client's HTTP error format. */
export function clientError(client, kind, message) {
  const rendered = (client === "messages" ? messagesErrorBody : responsesErrorBody)({
    kind,
    status: null,
    message,
  });
  return {
    ...rendered,
    headers: { "content-type": "application/json", ...rendered.headers },
  };
}

/** Message for a refused oversized request body. */
export function bodyLimitMessage(limit) {
  const size = limit % MIB === 0 ? `${limit / MIB} MiB` : `${limit} bytes`;
  return `request body exceeds ${size}`;
}

/**
 * Writes a translator or adapter rendering: a string is an in-stream (terminal) frame,
 * an object a full `{ status, headers, body }` response; null writes nothing.
 */
export function writeRendered(res, rendered) {
  if (rendered === null || res.destroyed) return;
  if (typeof rendered === "string") return void res.end(rendered);
  if (!res.headersSent) res.writeHead(rendered.status, rendered.headers);
  res.end(
    typeof rendered.body === "string" ? rendered.body : JSON.stringify(rendered.body),
  );
}

/** Marks a request whose client went away before its body was complete. */
export const clientAborted = () =>
  Object.assign(new Error("client aborted the request"), { clientAborted: true });

/**
 * Reads the request body as UTF-8. Resolves null as soon as it exceeds `limit` (the rest
 * is drained, not buffered); rejects with `clientAborted()` when the client goes away.
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        chunks.length = 0;
        settle(resolve, null);
      } else chunks.push(chunk);
    });
    req.on("end", () => settle(resolve, Buffer.concat(chunks).toString("utf8")));
    req.on("error", () => settle(reject, clientAborted()));
    req.on("close", () => settle(reject, clientAborted()));
  });
}

/** Static HTTP 503 in the client protocol's error format, written as raw bytes after the supervisor gave up. */
export function unavailableResponse(client) {
  const rendered = clientError(
    client,
    "server",
    "the protocol adapter stopped after repeated crashes; restart the session",
  );
  const body = JSON.stringify(rendered.body);
  return (
    "HTTP/1.1 503 Service Unavailable\r\ncontent-type: application/json\r\n" +
    `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
  );
}
