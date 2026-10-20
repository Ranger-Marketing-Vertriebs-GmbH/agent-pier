import express from "express";
import { idleDuration } from "../features/login/login-store.js";
import { loginErrors, loginProblem } from "../features/login/login-errors.js";
import { loginMessages as copy } from "../lib/i18n/de/login.js";
import { principalOf } from "../features/users/identity.js";
const cookieName = "agentpier_session";
export function sessionToken(req) {
  const cookies = (req.headers.cookie || "").split(";").map((part) => part.trim());
  const matches = cookies.filter((part) => part.startsWith(cookieName + "="));
  return matches.length === 1 ? matches[0].slice(cookieName.length + 1) : "";
}
// Call only after authorizeRequest has checked the Host and Origin.
export function directLocalRequest(req, config) {
  return (
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) &&
    new Set([
      `127.0.0.1:${config.port}`,
      `localhost:${config.port}`,
      ...(config.devOrigins || []).map((origin) => new URL(origin).host),
    ]).has(req.headers.host) &&
    !Object.keys(req.headers).some(
      (key) =>
        key === "forwarded" ||
        key.startsWith("x-forwarded-") ||
        key.startsWith("tailscale-"),
    )
  );
}
/**
 * Who may create the owner account. Any tailnet member and, once users exist, anyone on
 * the plain network reaches the sign-in, so neither may claim the owner during a reset.
 */
export function setupAllowed(req, config, hasUsers) {
  if (directLocalRequest(req, config)) return true;
  if (req.trustBranch === "tailscale")
    return (
      typeof config.ownerLogin === "string" &&
      req.headers["tailscale-user-login"] === config.ownerLogin
    );
  // A headless install sets up its owner over the network before any user exists.
  return req.trustBranch === "network" && !hasUsers;
}
/**
 * The attempt window a sign-in counts against. Tailscale Serve proxies every tailnet
 * device from loopback, so each tailnet login gets its own window, apart from the
 * local machine's; plain network requests count per address.
 */
export function attemptSource(req) {
  if (req.trustBranch === "tailscale")
    return `tailscale:${req.headers["tailscale-user-login"]}`;
  if (req.trustBranch === "local") return "local";
  return `network:${req.socket.remoteAddress}`;
}
// Secure only when the transport is TLS or the request uses the HTTPS Tailscale host.
export function cookieOptions(req, config) {
  const tailscaleHttps =
    req.trustBranch === "tailscale" && config.remoteUrl?.startsWith("https://");
  return {
    httpOnly: true,
    sameSite: "strict",
    secure: Boolean(req.socket.encrypted) || Boolean(tailscaleHttps),
    path: "/",
  };
}
export function loginRoutes(login, effective) {
  const router = express.Router();
  router.use(express.json({ limit: "4kb", strict: true }));
  const status = (req) => {
    const signedIn = login.describe(sessionToken(req));
    return {
      configured: login.configured,
      authenticated: Boolean(signedIn.role),
      canSetup: !login.configured && setupAllowed(req, effective(), login.hasUsers),
      ...signedIn,
    };
  };
  const cookie = (req, res, token) =>
    res.cookie(cookieName, token, {
      ...cookieOptions(req, effective()),
      maxAge: token ? idleDuration : 0,
    });
  router.get("/status", (req, res) => res.json(status(req)));
  router.post("/setup", async (req, res) => {
    if (!login.configured && !setupAllowed(req, effective(), login.hasUsers))
      throw loginProblem("LOGIN_SETUP_LOCAL_ONLY");
    cookie(req, res, await login.setup(req.body, attemptSource(req)));
    res.status(201).json({ authenticated: true });
  });
  router.post("/login", async (req, res) => {
    const token = await login.login(req.body, attemptSource(req));
    login.revoke(sessionToken(req));
    cookie(req, res, token);
    res.json({ authenticated: true });
  });
  router.post("/logout", (req, res) => {
    login.revoke(sessionToken(req));
    cookie(req, res, "");
    res.sendStatus(204);
  });
  router.use((error, _req, res, _next) => {
    const expected = Object.hasOwn(loginErrors, error.code) && loginErrors[error.code];
    if (expected) {
      if (expected.status === 429) res.setHeader("Retry-After", "60");
      return res
        .status(expected.status)
        .json({ code: error.code, error: expected.message });
    }
    // Parser failures retain their client status; unexpected failures never expose diagnostics.
    const parserStatuses = {
      "entity.too.large": 413,
      "entity.parse.failed": 400,
      "charset.unsupported": 415,
      "encoding.unsupported": 415,
      "request.aborted": 400,
      "request.size.invalid": 400,
    };
    const status = Object.hasOwn(parserStatuses, error.type)
      ? parserStatuses[error.type]
      : 500;
    res.status(status).json({ code: "LOGIN_FAILED", error: copy.failed });
  });
  return router;
}
export function requireLogin(login, effective) {
  return (req, res, next) => {
    if (
      (req.method === "GET" || req.method === "HEAD") &&
      req.path === "/health" &&
      directLocalRequest(req, effective())
    )
      return next();
    const token = sessionToken(req);
    const session = login.require(token);
    // WebSocket upgrades cannot set cookies; the next page request carries the renewal.
    const maxAge = login.renew(session);
    if (maxAge)
      res.cookie(cookieName, token, { ...cookieOptions(req, effective()), maxAge });
    const cleanup = login.watch(session, () => res.destroy());
    res.once("close", cleanup);
    req.principal = principalOf(session);
    next();
  };
}
