import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { devOrigins, devPorts } from "../../server/lib/dev-ports.js";
import { authorizeRequest } from "../../server/http/security.js";
import { loadConfig } from "../../server/lib/config.js";
import viteConfig, { devServer } from "../../vite.config.js";

test("without a configured port the dev server keeps 5173 and proxies to 4380", () => {
  assert.deepEqual(devPorts({}), { backend: 4380, vite: 5173 });
  assert.deepEqual(devPorts({ AGENTPIER_PORT: "", AGENTPIER_PORT_COUNT: "" }), {
    backend: 4380,
    vite: 5173,
  });
  assert.deepEqual(devOrigins({}), ["http://127.0.0.1:5173", "http://localhost:5173"]);
});

test("a port without a block moves only the proxy target", () => {
  assert.deepEqual(devPorts({ AGENTPIER_PORT: "4391" }), { backend: 4391, vite: 5173 });
  assert.deepEqual(devPorts({ TUIUI_PORT: "4392" }), { backend: 4392, vite: 5173 });
  assert.deepEqual(devPorts({ AGENTPIER_PORT: "4393", TUIUI_PORT: "4392" }), {
    backend: 4393,
    vite: 5173,
  });
});

test("a leased block puts the backend on its first and Vite on its second port", () => {
  const env = { AGENTPIER_PORT: "20110", AGENTPIER_PORT_COUNT: "3" };
  assert.deepEqual(devPorts(env), { backend: 20110, vite: 20111 });
  assert.deepEqual(devPorts({ ...env, AGENTPIER_PORT_COUNT: "2" }), {
    backend: 20110,
    vite: 20111,
  });
  assert.deepEqual(devOrigins(env), ["http://127.0.0.1:20111", "http://localhost:20111"]);
});

test("a block of one port has no room for Vite and fails clearly", () => {
  assert.throws(
    () => devPorts({ AGENTPIER_PORT: "20110", AGENTPIER_PORT_COUNT: "1" }),
    /AGENTPIER_PORT_COUNT=1.*npm run build && npm start/s,
  );
  assert.throws(
    () => devPorts({ AGENTPIER_PORT: "65535", AGENTPIER_PORT_COUNT: "2" }),
    /65535/,
  );
});

test("invalid ports and counts are rejected instead of guessed", () => {
  for (const AGENTPIER_PORT of ["abc", "80", "65536", "4380.5", "0x111c", " 4380", "-1"])
    assert.throws(() => devPorts({ AGENTPIER_PORT }), /AGENTPIER_PORT/, AGENTPIER_PORT);
  for (const AGENTPIER_PORT_COUNT of ["0", "-2", "two", "2.5", "1e1"])
    assert.throws(
      () => devPorts({ AGENTPIER_PORT: "20110", AGENTPIER_PORT_COUNT }),
      /AGENTPIER_PORT_COUNT/,
      AGENTPIER_PORT_COUNT,
    );
  assert.throws(
    () => devPorts({ AGENTPIER_PORT_COUNT: "3" }),
    /AGENTPIER_PORT_COUNT.*AGENTPIER_PORT/s,
  );
});

test("the backend admits exactly the derived dev origin and nothing next to it", () => {
  const env = { AGENTPIER_PORT: "20110", AGENTPIER_PORT_COUNT: "3" };
  const origins = devOrigins(env);
  assert.equal(origins.length, 2);
  for (const origin of origins) {
    const url = new URL(origin);
    assert.equal(url.port, "20111");
    assert.equal(url.pathname, "/");
    assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  }
  const config = { port: 20110, devOrigins: origins };
  const request = (host, origin) => ({
    headers: { host, origin },
    method: "POST",
    socket: { remoteAddress: "127.0.0.1" },
  });
  for (const host of ["127.0.0.1:20111", "localhost:20111"])
    assert.equal(authorizeRequest(request(host, `http://${host}`), config), true, host);
  for (const host of ["127.0.0.1:5173", "127.0.0.1:20112", "localhost:20109"])
    assert.throws(() => authorizeRequest(request(host, `http://${host}`), config), host);
  assert.throws(() =>
    authorizeRequest(request("127.0.0.1:20111", "http://127.0.0.1:20112"), config),
  );
});

const variables = [
  "AGENTPIER_DATA_DIR",
  "AGENTPIER_PORT",
  "AGENTPIER_PORT_COUNT",
  "AGENTPIER_DEV",
  "TUIUI_PORT",
  "TUIUI_DEV",
];
function environment(t, values) {
  const saved = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  const dataDir = mkdtempSync(path.join(tmpdir(), "agentpier-dev-ports-"));
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(saved))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  });
  for (const key of variables) delete process.env[key];
  Object.assign(process.env, { AGENTPIER_DATA_DIR: dataDir }, values);
}

test("the backend allowlist follows the same leased block as Vite", (t) => {
  environment(t, { AGENTPIER_DEV: "1" });
  assert.deepEqual(loadConfig().devOrigins, [
    "http://127.0.0.1:5173",
    "http://localhost:5173",
  ]);
  Object.assign(process.env, { AGENTPIER_PORT: "20110", AGENTPIER_PORT_COUNT: "3" });
  const config = loadConfig();
  assert.equal(config.port, 20110);
  assert.deepEqual(config.devOrigins, devOrigins(process.env));
  assert.deepEqual(config.devOrigins, [
    "http://127.0.0.1:20111",
    "http://localhost:20111",
  ]);
});

test("outside dev mode a one-port block still starts the backend", (t) => {
  environment(t, { AGENTPIER_PORT: "20110", AGENTPIER_PORT_COUNT: "1" });
  assert.deepEqual(loadConfig().devOrigins, []);
  process.env.AGENTPIER_DEV = "1";
  assert.throws(() => loadConfig(), /AGENTPIER_PORT_COUNT=1/);
});

test("vite.config.js serves and proxies on the derived ports only for the dev server", () => {
  assert.deepEqual(devServer({}), {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:4380", ws: true },
      "/auth": { target: "http://127.0.0.1:4380" },
    },
  });
  const leased = devServer({ AGENTPIER_PORT: "20110", AGENTPIER_PORT_COUNT: "3" });
  assert.equal(leased.port, 20111);
  assert.equal(leased.proxy["/api"].target, "http://127.0.0.1:20110");
  assert.equal(leased.proxy["/auth"].target, "http://127.0.0.1:20110");
  const saved = process.env.AGENTPIER_PORT_COUNT;
  process.env.AGENTPIER_PORT_COUNT = "1";
  try {
    for (const env of [{ command: "build" }, { command: "serve", isPreview: true }])
      assert.deepEqual(viteConfig({ mode: "production", ...env }).server, {
        host: "127.0.0.1",
      });
  } finally {
    if (saved === undefined) delete process.env.AGENTPIER_PORT_COUNT;
    else process.env.AGENTPIER_PORT_COUNT = saved;
  }
});
