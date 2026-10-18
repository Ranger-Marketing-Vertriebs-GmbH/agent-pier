import { serverMessages } from "../lib/i18n/de.js";
import { problem } from "../lib/storage.js";
import {
  cliOAuthCallbackPath,
  oauthCallbackPath,
} from "../features/mcp-servers/oauth-redirect.js";
export const appDocumentPath =
  /^\/(?:agents(?:\/[A-Za-z0-9_-]+\/(?:settings|(?:chats|teams)\/[A-Za-z0-9_-]+))?|inbox(?:\/(?:question|approval|gate|action|team)\/[A-Za-z0-9_-]+)?|accounts|repositories|files|artifacts(?:\/(?:view\/)?[A-Za-z0-9_-]+)?|settings(?:\/(?:assistants-advanced|assistants|notifications|diagnostics|backups|updates|audit|mcp|remote|ssh|github|components))?|projects(?:\/[^/]+)?|memory(?:\/[^/]+)?|pipelines(?:\/(?:runs|definitions|profiles|verification)(?:\/[^/]+)?)?|agentbus(?:\/messages(?:\/[^/]+)?)?|(?:extensions|plugins)(?:\/[^/]+)?|sessions\/[^/]+(?:\/(?:chat|reader|terminal|files))?)?\/?$/;
export function authorizeRequest(req, config, websocket = false) {
  if (req.headers.authorization)
    throw problem("Machine tokens are accepted only at the MCP endpoint.", 403);
  const host = req.headers.host;
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
    req.socket.remoteAddress,
  );
  const localHosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  // The dev server is explicitly enabled by local configuration, never trusted in production.
  for (const origin of config.devOrigins || []) localHosts.add(new URL(origin).host);
  const headerNames = Object.keys(req.headers);
  const proxyMarkers = headerNames.some(
    (key) =>
      key.startsWith("tailscale-") ||
      key.startsWith("x-forwarded-") ||
      key === "forwarded",
  );
  const tailscaleMarkers = headerNames.some((key) => key.startsWith("tailscale-"));
  let expected;
  if (loopback && localHosts.has(host)) {
    // Serve routes by TLS SNI and preserves Host: proxy markers must never enter the local trust branch.
    if (proxyMarkers) throw problem(serverMessages.http.proxyHostRequired, 403);
    expected = `http://${host}`;
    req.trustBranch = "local";
  } else if (loopback && config.remoteUrl && new URL(config.remoteUrl).host === host) {
    if (!config.ownerLogin || req.headers["tailscale-user-login"] !== config.ownerLogin)
      throw problem(serverMessages.http.tailscaleAccountDenied, 403);
    expected = new URL(config.remoteUrl).origin;
    req.trustBranch = "tailscale";
  } else if (config.network?.enabled && config.networkHosts?.has(host)) {
    // Plain network access: the login protects the workspace; Tailscale markers never downgrade here.
    if (tailscaleMarkers) throw problem(serverMessages.http.proxyHostRequired, 403);
    expected = `http://${host}`;
    req.trustBranch = "network";
  } else if (!loopback) throw problem(serverMessages.http.networkHostNotAllowed, 403);
  else throw problem(serverMessages.http.hostNotAllowed, 403);
  // Top-level HTML navigation is read-only; WebKit may omit activation metadata. The
  // OAuth callbacks are the provider's redirect back, authenticated by their state
  // (a brokered Codex login appends one path segment of its own).
  const requestPath = (req.url || "").split("?")[0];
  const callback =
    requestPath === oauthCallbackPath ||
    (requestPath.startsWith(`${cliOAuthCallbackPath}/`) &&
      !requestPath.slice(cliOAuthCallbackPath.length + 1).includes("/"));
  const openingPage =
    !websocket &&
    req.method === "GET" &&
    (appDocumentPath.test(requestPath) || callback) &&
    req.headers["sec-fetch-mode"] === "navigate" &&
    // The service worker re-fetches a navigation (an OAuth return, a link): Chrome
    // keeps mode navigate but reports the destination as empty. No page can start a
    // navigate-mode request with fetch(), so only this origin's worker sends that pair.
    ["document", "empty"].includes(req.headers["sec-fetch-dest"]);
  if (req.headers["sec-fetch-site"] === "cross-site" && !openingPage)
    throw problem(serverMessages.http.crossSiteAccessDenied, 403);
  const origin = req.headers.origin;
  if (origin && origin !== expected)
    throw problem(serverMessages.http.invalidOrigin, 403);
  if ((websocket || !["GET", "HEAD"].includes(req.method)) && !origin)
    throw problem(serverMessages.http.originRequired, 403);
  return true;
}
export function securityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  // blob: images: the browser live view shows each frame as an object URL.
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader("Cache-Control", "no-store");
  if (/^\/artifacts\/view\/[A-Za-z0-9-]+\/?$/.test(req.path)) {
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' data: 'unsafe-inline'; style-src 'self' data: 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  }
  next();
}
