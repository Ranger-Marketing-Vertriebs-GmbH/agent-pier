import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../../server/app.js";
import { remoteRoutes, remoteLocked } from "../../server/http/routes/remote.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "remote-route-"));
  const home = path.join(root, "home");
  await fs.mkdir(home, { mode: 0o700 });
  const dataDir = path.join(root, "data");
  const restarts = [];
  const application = await createApplication({
    dataDir,
    home,
    port: 0,
    remoteUrl: "https://host.example.ts.net:8443",
    ownerLogin: "owner@example.com",
    devOrigins: [],
    network: { enabled: false, bind: "0.0.0.0", hosts: [] },
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
  return { application, dataDir, request, restarts, port };
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
test("requests through the network branch may only switch the mode off", () => {
  const config = {
    port: 4380,
    remoteUrl: null,
    network: { enabled: true, bind: "0.0.0.0", hosts: [] },
    networkHosts: new Set(["192.168.1.20:4380"]),
  };
  const lan = {
    headers: { host: "192.168.1.20:4380" },
    socket: { remoteAddress: "192.168.1.55" },
  };
  const local = {
    headers: { host: "127.0.0.1:4380" },
    socket: { remoteAddress: "127.0.0.1" },
  };
  assert.equal(remoteLocked(lan, config), true);
  assert.equal(remoteLocked(local, config), false);
});
