import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import {
  assertAllowedAddresses,
  classifyAddress,
} from "../providers/endpoint-address.js";

// The fetch of AgentPier's own MCP OAuth flow (mcp-oauth-agentpier.js). The owner
// entered the server's URL; every other URL of the flow (the authorization server,
// its token and registration endpoints) is named by the server's metadata, on a login
// and again on every renewal. So each request is checked before it is sent:
//
// - A URL on the origin of the server's own URL is the owner's choice and passes.
// - Any other URL passes the endpoint address rule (endpoint-address.js: no
//   unroutable address, plain http only to local addresses) and may be no more
//   internal than the server itself. A server on the public internet reaches only
//   public addresses; one in the private network also private ones; only a server
//   on this machine reaches loopback and link-local addresses.
//
// The request then connects to exactly the addresses that were checked, so a name
// that resolves differently a moment later reaches nothing else. Redirects are never
// followed here: the SDK asks for each hop itself (same origin only), and each hop
// is a new request through this check.

const REACH = { public: 0, cgnat: 1, private: 1, linkLocal: 2, loopback: 3 };
// A name the owner entered may resolve to anything its DNS says, so it counts as
// part of the private network at most; only an address literal or `localhost` counts
// as this machine.
const NAMED_REACH = REACH.private;
const TIMEOUT = 30_000;
const LOOKUP_TIMEOUT = 10_000;
const LIMIT = 1024 * 1024;

/** A refusal by the address rule; deliberately not the TypeError of a network failure. */
export class OAuthAddressRefused extends Error {
  constructor() {
    super("The OAuth flow named an address AgentPier does not connect to.");
    this.name = "OAuthAddressRefused";
    this.code = "OAUTH_ADDRESS_REFUSED";
  }
}

// What global fetch reports for an unreachable host; the SDK's discovery relies on it.
const unreachable = () => new TypeError("fetch failed");
const hostOf = (url) => url.hostname.replace(/^\[|\]$/g, "");
const reachOf = (addresses) =>
  Math.max(...addresses.map(({ address }) => REACH[classifyAddress(address)] ?? 0));

async function resolveAll(url, lookup) {
  const host = hostOf(url);
  if (net.isIP(host)) return [{ address: host, family: net.isIP(host) }];
  let timer;
  const found = await Promise.race([
    lookup(host, { all: true, verbatim: true }),
    new Promise((_resolve, reject) => {
      timer = setTimeout(reject, LOOKUP_TIMEOUT);
    }),
  ])
    .catch(() => {
      throw unreachable();
    })
    .finally(() => clearTimeout(timer));
  if (!Array.isArray(found) || !found.length) throw unreachable();
  return found.map(({ address, family }) => ({ address, family }));
}

async function serverReach(server, lookup) {
  const host = hostOf(server);
  const literal = net.isIP(host) || host === "localhost" || host.endsWith(".localhost");
  const reach = await resolveAll(server, lookup).then(reachOf, () => REACH.public);
  return literal ? reach : Math.min(reach, NAMED_REACH);
}

function decoded(buffer, encoding) {
  const options = { maxOutputLength: LIMIT };
  if (encoding === "gzip" || encoding === "x-gzip")
    return zlib.gunzipSync(buffer, options);
  if (encoding === "deflate") return zlib.inflateSync(buffer, options);
  if (encoding === "br") return zlib.brotliDecompressSync(buffer, options);
  return null;
}

/**
 * One HTTP request to `addresses` only (Host, SNI and the certificate check keep the
 * URL's name), answered as a `Response`. Redirects are returned as they are, bodies
 * are capped at 1 MB, and every network failure is fetch's `TypeError`.
 */
export function pinnedSend(url, init = {}, addresses) {
  const secure = url.protocol === "https:";
  const host = hostOf(url);
  const method = (init.method || "GET").toUpperCase();
  const headers = Object.fromEntries(new Headers(init.headers || {}).entries());
  headers["accept-encoding"] = "identity";
  let body = init.body ?? undefined;
  if (body instanceof URLSearchParams) {
    headers["content-type"] ??= "application/x-www-form-urlencoded;charset=UTF-8";
    body = body.toString();
  }
  if (body !== undefined) {
    body = Buffer.from(String(body));
    headers["content-length"] = String(body.length);
  }
  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
      if (error) {
        request?.destroy();
        reject(error);
      } else resolve(value);
    };
    const onAbort = () => finish(init.signal.reason ?? unreachable());
    const timer = setTimeout(() => finish(unreachable()), TIMEOUT);
    if (init.signal?.aborted) return onAbort();
    init.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      request = (secure ? https : http).request(
        url,
        {
          method,
          headers,
          agent: false,
          autoSelectFamily: true,
          lookup: (_hostname, options, callback) =>
            options?.all
              ? callback(null, addresses)
              : callback(null, addresses[0].address, addresses[0].family),
          ...(secure && !net.isIP(host) ? { servername: host } : {}),
        },
        (response) => {
          const chunks = [];
          let size = 0;
          response.on("error", () => finish(unreachable()));
          response.on("close", () => {
            if (!response.complete) finish(unreachable());
          });
          response.on("data", (chunk) => {
            size += chunk.length;
            if (size > LIMIT) finish(unreachable());
            else chunks.push(chunk);
          });
          response.on("end", () => {
            const answer = new Headers();
            for (const [name, value] of Object.entries(response.headers))
              for (const item of [value].flat()) answer.append(name, item);
            let content = Buffer.concat(chunks);
            try {
              const plain = decoded(content, answer.get("content-encoding"));
              if (plain) {
                content = plain;
                answer.delete("content-encoding");
                answer.delete("content-length");
              }
              const status = response.statusCode;
              const empty = method === "HEAD" || [204, 205, 304].includes(status);
              finish(
                null,
                new Response(empty ? null : content, {
                  status,
                  statusText: response.statusMessage,
                  headers: answer,
                }),
              );
            } catch {
              finish(unreachable());
            }
          });
        },
      );
    } catch {
      return finish(unreachable());
    }
    request.on("error", () => finish(unreachable()));
    request.end(body);
  });
}

/**
 * The checked fetch for the OAuth flow of the server at `serverUrl`. `lookup` is
 * `dns.promises.lookup`; `send(url, init, addresses)` performs a checked request.
 */
export function oauthFetch(
  serverUrl,
  { lookup = dns.promises.lookup, send = pinnedSend } = {},
) {
  const server = new URL(serverUrl);
  let reach;
  return async (input, init = {}) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.protocol !== "http:" && url.protocol !== "https:")
      throw new OAuthAddressRefused();
    const addresses = await resolveAll(url, lookup);
    if (url.origin !== server.origin) {
      try {
        assertAllowedAddresses(addresses, url.protocol);
      } catch {
        throw new OAuthAddressRefused();
      }
      reach ??= serverReach(server, lookup);
      if (reachOf(addresses) > (await reach)) throw new OAuthAddressRefused();
    }
    return send(url, init, addresses);
  };
}
