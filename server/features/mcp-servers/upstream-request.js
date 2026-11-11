import zlib from "node:zlib";
import { OAuthAddressRefused, addressRule, pinnedRequest } from "./oauth-fetch.js";

// A request of AgentPier's MCP proxy (mcp-proxy.js) to the server whose URL the owner
// entered. The server answers it, so the server also decides where a redirect points.
// Each hop is therefore a request of its own under the address rule of the OAuth flow
// (oauth-fetch.js): a URL on the server's origin passes, any other must pass the
// endpoint address rule and be no more internal than the server, and the connection
// goes to exactly the addresses that were checked. At most `MAX_REDIRECTS` redirects
// are followed. The server's credentials (`credentials`: the access token, and the
// headers of `private`) go to the server's own origin only.

export const MAX_REDIRECTS = 5;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
// Request headers that describe a body; dropped when a redirect turns a POST into a GET.
const BODY_HEADERS = ["content-type", "content-encoding", "content-language"];
// Headers that identify the caller to the server and stay on its origin: the MCP
// session is a bearer of its own.
const PRIVATE_HEADERS = ["authorization", "cookie", "mcp-session-id"];

/** A redirect the proxy does not follow: a refused address, or too many hops. */
export class RedirectRefused extends Error {
  constructor(reason, target) {
    super(`The MCP server redirected to a URL AgentPier does not follow (${reason}).`);
    this.name = "RedirectRefused";
    this.code = "REDIRECT_REFUSED";
    this.reason = reason;
    // Origin only: a path or query may carry what the server put there.
    this.target = target?.origin ?? null;
  }
}

const without = (headers, names) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => !names.includes(name)));

function discard(response) {
  response.on("error", () => {});
  response.destroy();
}

/**
 * `request(target, { method, headers, credentials, body, signal })` for the server at
 * `serverUrl`: `{ response, own }` with Node's response of the last hop (its body
 * still streaming) and whether that hop was on the server's origin. Header names are
 * lower case. Throws `RedirectRefused`, or fetch's `TypeError` for a network failure.
 * `lookup` and `send` replace the DNS lookup and the pinned request in tests.
 */
export function upstreamRequest(serverUrl, { lookup, send = pinnedRequest } = {}) {
  const origin = new URL(serverUrl).origin;
  const check = addressRule(serverUrl, { lookup });
  return async (target, { method, headers = {}, credentials = {}, body, signal }) => {
    let url = new URL(target);
    for (let hop = 0; ; hop++) {
      const own = url.origin === origin;
      let addresses;
      try {
        addresses = await check(url);
      } catch (error) {
        if (error instanceof OAuthAddressRefused && hop > 0)
          throw new RedirectRefused("address", url);
        throw error;
      }
      const response = await send(
        url,
        {
          method,
          headers: own
            ? { ...headers, ...credentials }
            : without(headers, PRIVATE_HEADERS),
          body,
          signal,
        },
        addresses,
      );
      const location = REDIRECTS.has(response.statusCode) && response.headers.location;
      if (!location) return { response, own };
      discard(response);
      let next;
      try {
        next = new URL(location, url);
      } catch {
        throw new RedirectRefused("location", null);
      }
      if (hop >= MAX_REDIRECTS) throw new RedirectRefused("hops", next);
      // As fetch does: 303 asks for a GET, and so do 301 and 302 after a POST.
      const status = response.statusCode;
      if (
        (status === 303 && method !== "GET" && method !== "HEAD") ||
        ((status === 301 || status === 302) && method === "POST")
      ) {
        method = "GET";
        body = undefined;
        headers = without(headers, BODY_HEADERS);
      }
      next.hash = "";
      url = next;
    }
  };
}

/** The response body as sent, decoded when the server compressed it unasked. */
export function plainBody(response) {
  const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
  const flush = { flush: zlib.constants.Z_SYNC_FLUSH };
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? zlib.createGunzip(flush)
      : encoding === "deflate"
        ? zlib.createInflate(flush)
        : encoding === "br"
          ? zlib.createBrotliDecompress({ flush: zlib.constants.BROTLI_OPERATION_FLUSH })
          : null;
  if (!decoder) return response;
  response.on("error", (error) => decoder.destroy(error));
  return response.pipe(decoder);
}
