import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../../server/app.js";
import { remoteLocked } from "../../server/http/routes/remote.js";
import { authorizeRequest } from "../../server/http/security.js";
import { writeNetworkConfig } from "../../server/features/remote/network-access.js";

/** Sends a request with a raw Host header undici's fetch() cannot override. */
function rawRequest(port, { method, path: target, headers, body }) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        method,
        path: target,
        headers: {
          ...headers,
          ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, json: () => JSON.parse(raw) }),
        );
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function fixture(t, network = { enabled: false, bind: "0.0.0.0", hosts: [] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-route-"));
  const home = path.join(root, "home");
  await fs.mkdir(home, { mode: 0o700 });
  const dataDir = path.join(root, "data");
  // Mirrors what a prior, unlocked save would have persisted before a restart applied it.
  writeNetworkConfig(dataDir, network);
  const restarts = [];
  const application = await createApplication({
    dataDir,
    home,
    port: 0,
    remoteUrl: "https://host.example.ts.net:8443",
    ownerLogin: "owner@example.com",
    devOrigins: [],
    network,
    remoteRestart: async () => restarts.push(Date.now()),
  });
  await new Promise((resolve) => application.server.listen(0, "127.0.0.1", resolve));
  const port = application.server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const setup = await fetch(`${base}/auth/setup`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ username: "owner", password: "correct horse battery" }),
  });
  const cookie = setup.headers.get("set-cookie").split(";")[0];
  const request = (method, url, body, headers = {}) =>
    fetch(`${base}${url}`, {
      method,
      headers: { cookie, origin: base, "content-type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
  t.after(async () => {
    await application.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { application, dataDir, request, restarts, port, cookie };
}
test("remote settings read, validate, save and flag the restart", async (t) => {
  const f = await fixture(t);
  const initial = await (await f.request("GET", "/api/remote")).json();
  assert.equal(initial.local.url, `http://127.0.0.1:${f.port}`);
  assert.equal(initial.tailscale.url, "https://host.example.ts.net:8443");
  assert.deepEqual(initial.network.saved, { enabled: false, bind: "0.0.0.0", hosts: [] });
  assert.equal(initial.network.restartRequired, false);
  assert.equal(initial.network.locked, false);
  const invalid = await f.request("PUT", "/api/remote", {
    network: { enabled: true, hosts: ["a/b"] },
  });
  assert.equal(invalid.status, 400);
  const saved = await f.request("PUT", "/api/remote", {
    network: { enabled: true, bind: "0.0.0.0", hosts: ["Agentpier.Home.arpa"] },
  });
  assert.equal(saved.status, 200);
  const body = await saved.json();
  assert.deepEqual(body.network.saved, {
    enabled: true,
    bind: "0.0.0.0",
    hosts: ["agentpier.home.arpa"],
  });
  assert.equal(body.network.restartRequired, true);
  assert.equal(body.network.urls.includes(`http://agentpier.home.arpa:${f.port}`), true);
  const file = JSON.parse(await fs.readFile(path.join(f.dataDir, "config.json"), "utf8"));
  assert.deepEqual(file.network, {
    enabled: true,
    bind: "0.0.0.0",
    hosts: ["agentpier.home.arpa"],
  });
  const events = f.application.audit.list({ action: "setting.updated" }).events;
  assert.equal(events.length, 1);
  assert.equal(events[0].resourceId, "network-access");
  assert.equal(events[0].source, "user");
});
test("restart responds first and then calls the service adapter", async (t) => {
  const f = await fixture(t);
  const response = await f.request("POST", "/api/remote/restart");
  assert.equal(response.status, 202);
  assert.equal((await response.json()).restarting, true);
  assert.equal(f.restarts.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(f.restarts.length, 1);
});
test("the lock follows the trust branch authorizeRequest actually took", () => {
  const config = {
    port: 4380,
    remoteUrl: "https://host.example.ts.net:8443",
    ownerLogin: "owner@example.com",
    network: { enabled: true, bind: "0.0.0.0", hosts: ["host.example.ts.net"] },
    networkHosts: new Set(["192.168.1.20:4380", "host.example.ts.net:8443"]),
  };
  const request = (host, remoteAddress, headers = {}) => ({
    headers: { host, ...headers },
    method: "GET",
    socket: { remoteAddress },
  });
  const locked = (req, current = config) => {
    authorizeRequest(req, current);
    return remoteLocked(req);
  };
  assert.equal(locked(request("192.168.1.20:4380", "192.168.1.55")), true);
  assert.equal(locked(request("127.0.0.1:4380", "127.0.0.1")), false);
  assert.equal(
    locked(
      request("host.example.ts.net:8443", "127.0.0.1", {
        "tailscale-user-login": "owner@example.com",
      }),
    ),
    false,
  );
  // The same name reached over plain HTTP from the LAN is the network branch, not Tailscale.
  assert.equal(locked(request("host.example.ts.net:8443", "192.168.1.55")), true);
  assert.equal(
    locked(request("localhost:5173", "127.0.0.1"), {
      ...config,
      devOrigins: ["http://localhost:5173"],
    }),
    false,
  );
});
test("a request through the network branch may only disable the mode, checked through the real route", async (t) => {
  const network = { enabled: true, bind: "0.0.0.0", hosts: ["agentpier.test"] };
  const f = await fixture(t, network);
  const host = `agentpier.test:${f.port}`;
  const headers = {
    host,
    origin: `http://${host}`,
    cookie: f.cookie,
    "content-type": "application/json",
  };
  const locked = await rawRequest(f.port, {
    method: "PUT",
    path: "/api/remote",
    headers,
    body: {
      network: {
        enabled: true,
        bind: "0.0.0.0",
        hosts: ["agentpier.test", "other.test"],
      },
    },
  });
  assert.equal(locked.status, 403);
  const disabling = await rawRequest(f.port, {
    method: "PUT",
    path: "/api/remote",
    headers,
    body: { network: { enabled: false, bind: "0.0.0.0", hosts: ["agentpier.test"] } },
  });
  assert.equal(disabling.status, 200);
  assert.equal((await disabling.json()).network.saved.enabled, false);
  const view = await rawRequest(f.port, {
    method: "GET",
    path: "/api/remote",
    headers,
  });
  assert.equal((await view.json()).network.locked, true);
});
