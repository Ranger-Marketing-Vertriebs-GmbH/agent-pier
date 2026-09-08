import express from "express";
import { sessionDuration } from "../features/login/login-store.js";
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
export function loginRoutes(login, effective) {
  const router = express.Router();
  router.use(express.json({ limit: "4kb", strict: true }));
  const status = (req) => ({
    configured: login.configured,
    authenticated: Boolean(login.session(sessionToken(req))),
    canSetup: !login.configured,
  });
  const cookie = (req, res, token) => {
    const remote = !directLocalRequest(req, effective());
    const secure =
      Boolean(req.socket.encrypted) ||
      (remote && effective().remoteUrl?.startsWith("https://"));
    res.cookie(cookieName, token, {
      httpOnly: true,
      sameSite: "strict",
      secure,
      path: "/",
      maxAge: token ? sessionDuration : 0,
    });
  };
  router.get("/status", (req, res) => res.json(status(req)));
  router.post("/setup", async (req, res) => {
    cookie(req, res, await login.setup(req.body));
    res.status(201).json({ authenticated: true });
  });
  router.post("/login", async (req, res) => {
    const token = await login.login(req.body);
    login.revoke(sessionToken(req));
    cookie(req, res, token);
    res.json({ authenticated: true });
  });
  router.post("/logout", (req, res) => {
    login.revoke(sessionToken(req));
    cookie(req, res, "");
    res.sendStatus(204);
  });
  router.use((error, _req, res, next) => {
    if (error.status === 429) res.setHeader("Retry-After", "60");
    next(error);
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
    const session = login.require(sessionToken(req));
    const cleanup = login.watch(session, () => res.destroy());
    res.once("close", cleanup);
    next();
  };
}
