import http from "node:http";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { WebSocket } from "ws";
import { applicationFixture } from "../helpers/application.js";
const credentials = { username: "owner", password: "temporary-test-password" };
const post = (body, headers = {}) => ({ method: "POST", body, headers });
const cookieOf = (response) => response.headers.get("set-cookie").split(";")[0];

test("setup gates APIs and persists one private user and revocable sessions", async (t) => {
  const f = await applicationFixture(t, { authenticateFixture: false });
  assert.equal((await f.request("/api/state")).status, 401);
  assert.equal((await f.request("/api/health")).status, 200);
  assert.deepEqual(await (await f.request("/auth/status")).json(), {
    configured: false,
    authenticated: false,
    canSetup: true,
  });
  const created = await f.request("/auth/setup", post(credentials));
  assert.equal(created.status, 201);
  const cookie = cookieOf(created);
  assert.match(created.headers.get("set-cookie"), /HttpOnly/);
  assert.match(created.headers.get("set-cookie"), /SameSite=Strict/);
  assert.equal((await f.request("/api/state", { headers: { cookie } })).status, 200);
  assert.equal((await f.request("/auth/setup", post(credentials))).status, 409);
  assert.equal(
    (await f.request("/auth/login", post({ ...credentials, password: "wrong" }))).status,
    401,
  );
  await f.restart();
  assert.equal((await f.request("/api/state", { headers: { cookie } })).status, 200);
  const stored = await fs.readFile(path.join(f.dataDir, "login", "auth.json"), "utf8");
  assert.equal(stored.includes(credentials.password), false);
  assert.equal(stored.includes(cookie.split("=")[1]), false);
  assert.equal(
    (await fs.stat(path.join(f.dataDir, "login", "auth.json"))).mode & 0o777,
    0o600,
  );
  assert.equal((await f.request("/auth/logout", post({}, { cookie }))).status, 204);
  assert.equal((await f.request("/api/state", { headers: { cookie } })).status, 401);
  const login = await f.request("/auth/login", post(credentials));
  assert.equal(login.status, 200);
  assert.notEqual(cookieOf(login), cookie);
});

test("permitted network setup creates one user while forged proxy markers remain denied", async (t) => {
  const f = await applicationFixture(t, {
    authenticateFixture: false,
    remoteUrl: "https://agentpier.example",
    ownerLogin: "owner@example.test",
  });
  const headers = {
    host: "agentpier.example",
    "tailscale-user-login": "owner@example.test",
    origin: "https://agentpier.example",
  };
  const remote = (endpoint, method = "GET", body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        f.url + endpoint,
        { method, headers: { ...headers, "content-type": "application/json" } },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () =>
            resolve({
              status: res.statusCode,
              headers: res.headers,
              data: data ? JSON.parse(data) : null,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  assert.deepEqual((await remote("/auth/status")).data, {
    configured: false,
    authenticated: false,
    canSetup: true,
  });
  assert.equal((await remote("/api/health")).status, 401);
  assert.equal((await remote("/api/state")).status, 401);
  for (const marker of ["forwarded", "x-forwarded-for", "tailscale-user-login"])
    assert.equal(
      (await f.request("/auth/setup", post(credentials, { [marker]: "127.0.0.1" })))
        .status,
      403,
    );
  assert.equal(
    (
      await f.request("/auth/setup", {
        ...post(credentials),
        origin: "https://evil.example",
      })
    ).status,
    403,
  );
  const results = await Promise.all([
    remote("/auth/setup", "POST", credentials),
    remote("/auth/setup", "POST", { username: "other", password: "other-test-password" }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
  assert.match(
    results.find((r) => r.status === 201).headers["set-cookie"][0],
    /; Secure/,
  );
  assert.equal((await remote("/auth/setup", "POST", credentials)).status, 409);
});

test("terminal upgrades require a session and logout closes an existing socket", async (t) => {
  const f = await applicationFixture(t, { authenticateFixture: false });
  const endpoint = f.url.replace("http:", "ws:") + "/api/sessions/test/terminal";
  const denied = new WebSocket(endpoint, { origin: f.url });
  const status = await new Promise((resolve, reject) => {
    denied.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode);
      res.destroy();
      denied.terminate();
    });
    denied.on("error", () => {});
    denied.on("open", () => reject(new Error("Unauthenticated terminal opened")));
  });
  assert.equal(status, 401);
  const cookie = cookieOf(await f.request("/auth/setup", post(credentials)));
  f.application.sessions.get = async () => ({ status: "exited" });
  f.application.sessions.screen = async () => "fixture";
  const socket = new WebSocket(endpoint, { origin: f.url, headers: { cookie } });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await f.request("/auth/logout", post({}, { cookie }));
  assert.equal(await closed, 1008);
});

test("login throttles repeated guesses and rejects oversized or weak setup input", async (t) => {
  const f = await applicationFixture(t, { authenticateFixture: false });
  assert.equal(
    (await f.request("/auth/setup", post({ username: "owner", password: "short" })))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request(
        "/auth/setup",
        post({ username: "owner", password: "x".repeat(5000) }),
      )
    ).status,
    413,
  );
  await f.request("/auth/setup", post(credentials));
  let response;
  for (let i = 0; i < 12; i++)
    response = await f.request(
      "/auth/login",
      post({ ...credentials, password: "incorrect" }),
    );
  assert.equal(response.status, 429);
  assert.ok(response.headers.get("retry-after"));
});

test("logout rejects queued terminal input while attachment is still pending", async (t) => {
  const f = await applicationFixture(t, { authenticateFixture: false });
  const cookie = cookieOf(await f.request("/auth/setup", post(credentials)));
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  let writes = 0;
  f.application.sessions.get = async () => {
    await pending;
    return { status: "running" };
  };
  f.application.sessions.attach = async () => ({
    write: async () => {
      writes++;
    },
    dispose() {},
  });
  const socket = new WebSocket(
    f.url.replace("http:", "ws:") + "/api/sessions/test/terminal",
    { origin: f.url, headers: { cookie } },
  );
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(JSON.stringify({ type: "input", data: "should-never-run\r" }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  f.application.login.revoke(cookie.split("=")[1]);
  release();
  await new Promise((resolve) => socket.once("close", resolve));
  assert.equal(writes, 0);
});
