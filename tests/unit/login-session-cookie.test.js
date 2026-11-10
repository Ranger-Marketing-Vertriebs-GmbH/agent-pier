import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import express from "express";
import { LoginStore } from "../../server/features/login/login-store.js";
import {
  cookieOptions,
  loginRoutes,
  requireLogin,
  sessionToken,
} from "../../server/http/login.js";
import { authorizeRequest } from "../../server/http/security.js";
import {
  downstreamHeaders,
  withoutSessionCookie,
} from "../../server/features/previews/preview-headers.js";

const hosted = "__Host-agentpier_session";
const legacy = "agentpier_session";
const remoteUrl = "https://box.example.ts.net";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-session-cookie-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new LoginStore({ dataDir });
  // Hashing is not under test: install the owner directly.
  store.data.user = { username: "fixture", salt: "a".repeat(64), hash: "b".repeat(128) };
  store.save();
  return store;
}

// The owner's and the users' sessions behind one `session`, as Identity offers them.
const login = (store) => ({
  configured: true,
  hasUsers: false,
  session: (token) => store.session(token),
  require: (token) => store.require(token),
  renew: (row) => store.renew(row),
  watch: (row, close) => store.watch(row, close),
  revoke: (token) => store.revoke(token),
  describe: (token) => ({ role: store.session(token) ? "owner" : null, user: null }),
});

/** An app that marks each request the way authorizeRequest does for the given branch. */
async function serve(t, store, { https }) {
  const config = { port: 0, ...(https ? { remoteUrl } : {}) };
  const app = express();
  app.use((req, _res, next) => {
    req.trustBranch = https ? "tailscale" : "local";
    req.secureCookies = https;
    next();
  });
  app.use(
    "/auth",
    loginRoutes(login(store), () => config),
  );
  app.use(
    "/api",
    requireLogin(login(store), () => config),
  );
  app.get("/api/state", (_req, res) => res.json({ ok: true }));
  app.use((error, _req, res, _next) => res.status(error.status || 500).end());
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  return (pathname, cookie, method = "GET") =>
    fetch(base + pathname, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    });
}

const request = (cookie, secureCookies = false) => ({
  headers: { cookie },
  socket: {},
  secureCookies,
});

test("two different valid sessions in one request sign nobody in", (t) => {
  const store = fixture(t);
  const [own, other] = [store.issue(), store.issue()];
  assert.equal(sessionToken(request(`${legacy}=${own}; ${legacy}=${other}`), store), "");
  assert.equal(sessionToken(request(`${legacy}=${other}; ${legacy}=${own}`), store), "");
  // The same session twice, or beside values nobody issued, is still one session.
  assert.equal(sessionToken(request(`${legacy}=${own}; ${legacy}=${own}`), store), own);
  assert.equal(sessionToken(request(`${legacy}=planted; ${legacy}=${own}`), store), own);
});

test("over HTTPS a valid prefixed cookie decides alone", (t) => {
  const store = fixture(t);
  const [own, other] = [store.issue(), store.issue()];
  const both = `${legacy}=${other}; ${hosted}=${own}`;
  assert.equal(sessionToken(request(both, true), store), own);
  // Plain HTTP never trusts the prefix: only the earlier name counts there.
  assert.equal(sessionToken(request(both), store), other);
  assert.equal(sessionToken(request(`${hosted}=${own}`), store), "");
  // A session from before the update is still read over HTTPS.
  assert.equal(sessionToken(request(`${legacy}=${own}`, true), store), own);
  assert.equal(
    sessionToken(request(`${hosted}=stale; ${legacy}=${own}`, true), store),
    own,
  );
});

test("authorizeRequest marks exactly the requests whose cookie is Secure", () => {
  const config = { port: 4380, remoteUrl };
  const tailnet = {
    method: "GET",
    url: "/auth/status",
    headers: { host: "box.example.ts.net", "tailscale-user-login": "o@example.test" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  authorizeRequest(tailnet, config);
  assert.equal(tailnet.secureCookies, true);
  assert.equal(cookieOptions(tailnet, config).secure, true);
  const local = {
    method: "GET",
    url: "/auth/status",
    headers: { host: "127.0.0.1:4380" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  authorizeRequest(local, config);
  assert.notEqual(local.secureCookies, true);
  assert.equal(cookieOptions(local, config).secure, false);
});

test("a conflicting request is refused and its cookies are cleared", async (t) => {
  const store = fixture(t);
  const [own, other] = [store.issue(), store.issue()];
  const call = await serve(t, store, { https: false });
  const cookie = `${legacy}=${other}; ${legacy}=${own}`;
  const refused = await call("/api/state", cookie);
  assert.equal(refused.status, 401);
  assert.match(refused.headers.get("set-cookie"), /^agentpier_session=;.*Max-Age=0/);
  const status = await call("/auth/status", cookie);
  assert.equal((await status.json()).authenticated, false);
  assert.match(status.headers.get("set-cookie"), /^agentpier_session=;.*Max-Age=0/);
  // Refusing ends neither session: each alone still works.
  assert.equal((await call("/api/state", `${legacy}=${own}`)).status, 200);
});

test("signing out ends every session the browser presents", async (t) => {
  const store = fixture(t);
  const [own, other] = [store.issue(), store.issue()];
  const call = await serve(t, store, { https: false });
  const left = await call("/auth/logout", `${legacy}=${other}; ${legacy}=${own}`, "POST");
  assert.equal(left.status, 204);
  assert.equal(store.session(own), null);
  assert.equal(store.session(other), null);
});

test("an HTTPS session uses the prefixed cookie and an earlier one moves to it", async (t) => {
  const store = fixture(t);
  const own = store.issue();
  const call = await serve(t, store, { https: true });
  const moved = await call("/api/state", `${legacy}=${own}`);
  assert.equal(moved.status, 200);
  const cookies = moved.headers.getSetCookie();
  assert.match(cookies[0], new RegExp(`^${hosted}=${own}; Max-Age=\\d+; Path=/;`));
  assert.match(cookies[0], /HttpOnly; Secure; SameSite=Strict$/);
  assert.match(cookies[1], /^agentpier_session=; Max-Age=0; Path=\//);
  // Once moved, nothing is set again and the session is the same one.
  const kept = await call("/api/state", `${hosted}=${own}`);
  assert.equal(kept.status, 200);
  assert.deepEqual(kept.headers.getSetCookie(), []);
  const left = await call("/auth/logout", `${hosted}=${own}`, "POST");
  assert.deepEqual(
    left.headers.getSetCookie().map((line) => line.split(";")[0]),
    [`${hosted}=`, `${legacy}=`],
  );
  assert.equal(store.session(own), null);
});

test("plain HTTP keeps the earlier cookie name", async (t) => {
  const store = fixture(t);
  const own = store.issue();
  const call = await serve(t, store, { https: false });
  const answer = await call("/api/state", `${legacy}=${own}`);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.headers.getSetCookie(), []);
});

test("a preview never sees or sets the session under either name", () => {
  assert.equal(withoutSessionCookie(`a=1; ${hosted}=x; ${legacy}=y; b=2`), "a=1; b=2");
  const headers = downstreamHeaders(
    { "set-cookie": [`${hosted}=planted; Path=/; Secure`, "app=1; Path=/"] },
    { target: 5173, previewOrigin: "https://box.example.ts.net:47100" },
  );
  assert.deepEqual(headers["set-cookie"], ["app=1; Path=/"]);
});
