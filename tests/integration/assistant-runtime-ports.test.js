import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";
import { issueGatewayCertificate } from "../../server/features/assistants/gateway-tls.js";

// The Gateway port is drawn free and released (freePort), so another listener may
// take it before the Gateway binds it: the team bridge's own listen(0) did on Linux
// runners (AGENTPIER-198). A start tries up to three fresh ports before it fails,
// and the token never reaches whoever holds the port.
function fakeGateway(t, prefix, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entryPath = path.join(dataDir, "gateway.mjs");
  const helper = path.resolve("tests/helpers/assistant-fake-gateway.js");
  fs.writeFileSync(
    entryPath,
    `import { runFakeGateway } from ${JSON.stringify(helper)};\n` +
      `runFakeGateway(${JSON.stringify(options)});`,
  );
  const install = async () => ({
    nodePath: process.execPath,
    entryPath,
    version: "fixture",
  });
  return { dataDir, install };
}
const tokenOf = (runtime) =>
  JSON.parse(fs.readFileSync(runtime.paths.config, "utf8")).gateway.auth.token;
// Records each launch's port; the first one is taken by `squatter` before the bind.
function takeFirstPort(t, runtime, squatter) {
  const ports = [];
  t.after(() => new Promise((r) => squatter.close(r)));
  runtime.beforeSpawn = async () => {
    const { port } = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8")).gateway;
    ports.push(port);
    if (ports.length === 1)
      await new Promise((r) => squatter.listen(port, "127.0.0.1", r));
  };
  return ports;
}
async function assertRecovered(runtime, ports, states) {
  assert.equal(runtime.status().availability, "ready");
  assert.equal(states.includes("failed"), false, "the caller never sees a failed start");
  assert.equal(runtime.attempts, 0, "no restart attempt is consumed");
  assert.ok(!runtime.retryTimer, "no restart is left behind");
  assert.equal(ports.length, 2);
  assert.notEqual(ports[1], ports[0]);
  assert.equal(runtime.client.url, `wss://127.0.0.1:${ports[1]}`);
  assert.deepEqual(await runtime.client.call("anything"), { value: 42 });
}

test("an impostor on the Gateway port never receives the token", async (t) => {
  const record = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "impostor-")), "log");
  const { dataDir, install } = fakeGateway(t, "assistant-gateway-impostor-", {
    impostor: true,
    record,
  });
  const runtime = new RuntimeSupervisor({
    dataDir,
    install,
    timing: { restartMs: 60000 },
  });
  t.after(() => runtime.close());
  let launches = 0;
  runtime.beforeSpawn = async () => launches++;
  await assert.rejects(runtime.start(), { code: "ENDPOINT_UNTRUSTED" });
  assert.equal(launches, 3, "three fresh ports before the start fails");
  const received = fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "";
  assert.equal(received.includes(tokenOf(runtime)), false);
  assert.equal(received.includes("connect"), false);
  assert.equal(runtime.status().diagnostic, "ENDPOINT_UNTRUSTED");
  assert.ok(runtime.retryTimer, "a fresh port is tried after the backoff");
});

test("a TLS listener on the drawn port is abandoned for a fresh one within the start", async (t) => {
  // The Gateway stays up after its failed bind, so only the probe can fail.
  const { dataDir, install } = fakeGateway(t, "assistant-gateway-occupied-", {
    stayOnBindError: true,
  });
  const received = [];
  const squatter = tls.createServer(issueGatewayCertificate(), (socket) =>
    socket.on("data", (bytes) => received.push(bytes)),
  );
  squatter.on("tlsClientError", () => {});
  const runtime = new RuntimeSupervisor({
    dataDir,
    install,
    timing: { restartMs: 60000 },
  });
  t.after(() => runtime.close());
  const ports = takeFirstPort(t, runtime, squatter);
  const states = [];
  runtime.on("status", ({ availability }) => states.push(availability));
  await runtime.start();
  await assertRecovered(runtime, ports, states);
  assert.equal(Buffer.concat(received).includes(tokenOf(runtime)), false);
});

test("a Gateway that exits on a port a silent listener took restarts on a fresh one", async (t) => {
  // The fake exits on EADDRINUSE as OpenClaw does; the squatter accepts TCP and
  // never answers, so the probe alone would only time out.
  const { dataDir, install } = fakeGateway(t, "assistant-gateway-silent-");
  const sockets = [];
  const squatter = net.createServer((socket) => {
    socket.pause();
    sockets.push(socket);
  });
  t.after(() => sockets.forEach((socket) => socket.destroy()));
  const runtime = new RuntimeSupervisor({
    dataDir,
    install,
    timing: { restartMs: 60000 },
  });
  t.after(() => runtime.close());
  const ports = takeFirstPort(t, runtime, squatter);
  const states = [];
  runtime.on("status", ({ availability }) => states.push(availability));
  const started = Date.now();
  await runtime.start();
  await assertRecovered(runtime, ports, states);
  assert.ok(Date.now() - started < 5000, "the exit ends the pending probe at once");
});
