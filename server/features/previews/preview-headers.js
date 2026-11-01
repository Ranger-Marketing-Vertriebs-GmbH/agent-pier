const cookieName = "agentpier_session";

// Hop-by-hop headers belong to one connection and are never forwarded.
const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const named = (part, name) => part.split("=")[0].trim() === name;

/** A Cookie header without any agentpier_session value; null when nothing remains. */
export function withoutSessionCookie(cookie) {
  if (typeof cookie !== "string") return null;
  const kept = cookie
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part && !named(part, cookieName));
  return kept.length ? kept.join("; ") : null;
}

/** Rewrites `value` when it starts with `from` at an origin boundary. */
function rebase(value, from, to) {
  if (typeof value !== "string" || !value.startsWith(from)) return value;
  const rest = value.slice(from.length);
  return rest === "" || /^[/?#]/.test(rest) ? to + rest : value;
}

/**
 * The headers the dev server sees: AgentPier's session cookie, Tailscale identity and
 * any incoming forwarding claims are dropped; Host is what dev servers accept and the
 * preview origin is announced through the X-Forwarded-* headers.
 */
export function upstreamHeaders(req, { target, previewOrigin }) {
  const local = `http://localhost:${target}`;
  const headers = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      hopByHop.has(key) ||
      key === "host" ||
      key === "cookie" ||
      key === "forwarded" ||
      key.startsWith("x-forwarded-") ||
      key.startsWith("tailscale-")
    )
      continue;
    headers[key] = value;
  }
  const cookie = withoutSessionCookie(req.headers.cookie);
  if (cookie) headers.cookie = cookie;
  headers.host = `localhost:${target}`;
  if (headers.origin === previewOrigin) headers.origin = local;
  if (headers.referer) headers.referer = rebase(headers.referer, previewOrigin, local);
  const preview = new URL(previewOrigin);
  headers["x-forwarded-host"] = preview.host;
  headers["x-forwarded-proto"] = preview.protocol.slice(0, -1);
  headers["x-forwarded-for"] = req.socket?.remoteAddress || "";
  return headers;
}

/**
 * The headers the browser sees: the app's own, minus any agentpier_session cookie it
 * tries to set, with redirects to the dev server's loopback origin pointed at the
 * preview origin.
 */
export function downstreamHeaders(headers, { target, previewOrigin }) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key === "connection" || key === "keep-alive") continue;
    result[key] = value;
  }
  if (result["set-cookie"]) {
    const cookies = [].concat(result["set-cookie"]).filter((c) => !named(c, cookieName));
    if (cookies.length) result["set-cookie"] = cookies;
    else delete result["set-cookie"];
  }
  if (typeof result.location === "string")
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      const next = rebase(result.location, `http://${host}:${target}`, previewOrigin);
      if (next !== result.location) {
        result.location = next;
        break;
      }
    }
  return result;
}
