import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createApplication } from "../../server/app.js";
import {
  detectNetworkAddresses,
  normalizeNetworkConfig,
} from "../../server/features/remote/network-access.js";

async function start(t, network) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "network-binding-"));
  const home = path.join(root, "home");
  await fs.mkdir(home, { mode: 0o700 });
  const application = await createApplication({
    dataDir: path.join(root, "data"),
    home,
    port: 0,
    remoteUrl: null,
    ownerLogin: null,
    devOrigins: [],
    network,
  });
  await new Promise((resolve) =>
    application.server.listen(0, network.enabled ? network.bind : "127.0.0.1", resolve),
  );
  t.after(async () => {
    await application.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  return { application, port: application.server.address().port };
}
test("network mode exposes the allowed hosts and answers a LAN request with the login page", async (t) => {
  const { application, port } = await start(t, {
    enabled: true,
    bind: "0.0.0.0",
    hosts: ["agentpier.test"],
  });
  const state = application.networkState;
  assert.equal(state.hosts.has(`agentpier.test:${port}`), true);
  assert.equal(state.urls[0], `http://agentpier.test:${port}`);
  const { addresses } = detectNetworkAddresses();
  const lan = addresses.find((address) => address.includes("."));
  if (!lan) {
    t.diagnostic("no non-loopback IPv4 address on this machine; skipping LAN request");
    return;
  }
  const response = await fetch(`http://${lan}:${port}/auth/status`, {
    headers: { host: `${lan}:${port}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).configured, false);
  const denied = await fetch(`http://${lan}:${port}/api/health`);
  assert.equal(denied.status, 401);
});
test("the dual-stack bind still answers loopback IPv4 and only wildcards are accepted", async (t) => {
  const { port } = await start(t, { enabled: true, bind: "::", hosts: [] });
  const response = await fetch(`http://127.0.0.1:${port}/auth/status`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).configured, false);
  assert.throws(() => normalizeNetworkConfig({ enabled: true, bind: "192.168.1.5" }), {
    status: 400,
  });
});
test("disabled network mode keeps every non-loopback host rejected", async (t) => {
  const { application, port } = await start(t, {
    enabled: false,
    bind: "0.0.0.0",
    hosts: [],
  });
  assert.equal(application.networkState.hosts.size, 0);
  // fetch() always derives the Host header from the connection URL, so a raw
  // http.get() is used here to send a spoofed Host header on a loopback socket.
  const status = await new Promise((resolve, reject) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/auth/status",
        headers: { host: `192.168.1.20:${port}` },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(status, 403);
});
