import { serverMessages } from "../lib/i18n/de.js";
import { problem } from "../lib/storage.js";
export const appDocumentPath =
  /^\/(?:accounts|repositories|settings(?:\/(?:notifications|diagnostics|backups|updates|audit|mcp|ssh))?|memory(?:\/[^/]+)?|pipelines(?:\/(?:runs|definitions|profiles|verification)(?:\/[^/]+)?)?|agentbus(?:\/messages(?:\/[^/]+)?)?|(?:extensions|plugins)(?:\/[^/]+)?|sessions\/[^/]+(?:\/(?:chat|reader|terminal|files))?)?\/?$/;
export function authorizeRequest(req, config, websocket = false) {
  if (req.headers.authorization)
    throw problem("Machine tokens are accepted only at the MCP endpoint.", 403);
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress))
    throw problem(serverMessages.http.localOrTailscaleRequired, 403);
  const host = req.headers.host;
  const localHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  // The dev server is explicitly enabled by local configuration, never trusted in production.
  for (const origin of config.devOrigins || []) localHosts.add(new URL(origin).host);
  let expected;
  if (localHosts.has(host)) {
    // Serve routes by TLS SNI and preserves Host: proxy markers must never enter the local trust branch.
    if (
      Object.keys(req.headers).some(
        (key) =>
          key.startsWith("tailscale-") ||
          key.startsWith("x-forwarded-") ||
          key === "forwarded",
      )
    )
      throw problem(serverMessages.http.proxyHostRequired, 403);
    expected = `http://${host}`;
  } else if (config.remoteUrl && new URL(config.remoteUrl).host === host) {
    if (!config.ownerLogin || req.headers["tailscale-user-login"] !== config.ownerLogin)
      throw problem(serverMessages.http.tailscaleAccountDenied, 403);
    expected = new URL(config.remoteUrl).origin;
  } else throw problem(serverMessages.http.hostNotAllowed, 403);
  // Top-level HTML navigation is read-only; WebKit may omit activation metadata.
  const openingPage =
    !websocket &&
    req.method === "GET" &&
    appDocumentPath.test((req.url || "").split("?")[0]) &&
    req.headers["sec-fetch-mode"] === "navigate" &&
    req.headers["sec-fetch-dest"] === "document";
  if (req.headers["sec-fetch-site"] === "cross-site" && !openingPage)
    throw problem(serverMessages.http.crossSiteAccessDenied, 403);
  const origin = req.headers.origin;
  if (origin && origin !== expected)
    throw problem(serverMessages.http.invalidOrigin, 403);
  if ((websocket || !["GET", "HEAD"].includes(req.method)) && !origin)
    throw problem(serverMessages.http.originRequired, 403);
  return true;
}
export function securityHeaders(_req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader("Cache-Control", "no-store");
  next();
}
