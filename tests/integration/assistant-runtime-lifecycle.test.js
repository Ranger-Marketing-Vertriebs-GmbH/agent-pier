import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { EventEmitter, once } from "node:events";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { consoleLogLimit } from "../../server/features/assistants/gateway-log.js";
import { issueGatewayCertificate } from "../../server/features/assistants/gateway-tls.js";
test("disabled service stays inert and interrupted installation cannot launch after close", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-supervisor-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let finish;
  const supervisor = new RuntimeSupervisor({
    dataDir,
    install: () =>
      new Promise((r) => {
        finish = r;
      }),
    spawn: () => assert.fail("launched after close"),
  });
  assert.equal(supervisor.status().availability, "disabled");
  const starting = supervisor.start();
  await supervisor.close();
  finish({ nodePath: "not-used", entryPath: "not-used", version: "2026.9.8" });
  await starting;
  assert.equal(supervisor.status().availability, "disabled");
});
test("foreign ownership blocks startup without terminating that process", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-ownership-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, "assistants"));
  fs.writeFileSync(
    path.join(dataDir, "assistants", "owner.json"),
    JSON.stringify({ pid: process.pid }),
  );
  const supervisor = new RuntimeSupervisor({
    dataDir,
    install: () => assert.fail("should not install"),
  });
  await assert.rejects(supervisor.start(), /ownership/i);
  await assert.rejects(supervisor.assertStopped(), { code: "OWNERSHIP_CONFLICT" });
  assert.equal(supervisor.status().availability, "failed");
  await supervisor.close();
});

test("invalid config exit is terminal and never enters restart loop", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-invalid-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entryPath = path.join(dataDir, "invalid.mjs");
  fs.writeFileSync(entryPath, "process.exit(78)");
  const supervisor = new RuntimeSupervisor({
    dataDir,
    install: async () => ({ nodePath: process.execPath, entryPath, version: "fixture" }),
  });
  t.after(() => supervisor.close());
  await assert.rejects(supervisor.start(), { code: "INVALID_CONFIG" });
  assert.equal(supervisor.status().diagnostic, "INVALID_CONFIG");
  assert.equal(supervisor.retryTimer, undefined);
});

test("crash restart backoff is bounded to five attempts", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-backoff-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const supervisor = new RuntimeSupervisor({ dataDir });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  supervisor.wanted = true;
  let launches = 0;
  supervisor.start = async () => {
    launches++;
    supervisor.scheduleRestart();
  };
  supervisor.scheduleRestart();
  for (const duration of [1000, 2000, 4000, 8000, 16000, 32000])
    t.mock.timers.tick(duration);
  assert.equal(launches, 5);
  assert.equal(supervisor.status().availability, "failed");
  assert.equal(supervisor.status().diagnostic, "RESTART_LIMIT");
  await supervisor.close();
});

test("authentication failure terminates its owned child before another start", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-auth-failure-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entryPath = path.join(dataDir, "alive.mjs");
  fs.writeFileSync(entryPath, "setInterval(() => {}, 1000)");
  const supervisor = new RuntimeSupervisor({
    dataDir,
    install: async () => ({ nodePath: process.execPath, entryPath, version: "fixture" }),
    clientFactory: () => ({
      connect: async () => {
        throw Object.assign(Error("auth"), { code: "UNAUTHORIZED" });
      },
      close() {},
    }),
  });
  t.after(() => supervisor.close());
  await assert.rejects(supervisor.start(), { code: "UNAUTHORIZED" });
  assert.equal(supervisor.child, null);
  assert.equal(fs.existsSync(path.join(supervisor.paths.root, "owner.json")), false);
  assert.equal(supervisor.status().availability, "failed");
});
test("readiness waits on a wall-clock budget scaled by the slowest earlier start", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-ready-budget-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entryPath = path.join(dataDir, "alive.mjs");
  fs.writeFileSync(entryPath, "setInterval(() => {}, 1000)");
  // Refused probes fail instantly; their count must not bound the wait.
  let refusals = 0;
  let refuseFor = 400;
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => ({ nodePath: process.execPath, entryPath, version: "fixture" }),
    timing: { readyMs: 5000, readyPollMs: 1, readyFactor: 3 },
    clientFactory: () =>
      Object.assign(new EventEmitter(), {
        ready: false,
        async connect() {
          if (refusals++ < refuseFor)
            throw Object.assign(Error("refused"), { code: "UNAVAILABLE" });
          this.ready = true;
        },
        close() {
          this.ready = false;
        },
      }),
  });
  t.after(() => runtime.close());
  await runtime.start();
  assert.ok(refusals > 120);
  assert.equal(runtime.status().availability, "ready");
  // A restart that needs longer than the floor still gets three times the last start.
  runtime.lastReadyMs = 400;
  runtime.timing.readyMs = 50;
  refusals = 0;
  refuseFor = Infinity;
  const started = Date.now();
  await assert.rejects(runtime.restart(), { code: "UNAVAILABLE" });
  assert.ok(Date.now() - started >= 1100);
});
test("enabling after a failed connection retires the original owned process", async (t) => {
  const { EventEmitter } = await import("node:events");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-reenable-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entryPath = path.join(dataDir, "alive.mjs");
  fs.writeFileSync(entryPath, "setInterval(()=>{},1000)");
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => ({ nodePath: process.execPath, entryPath, version: "fixture" }),
    clientFactory: () =>
      Object.assign(new EventEmitter(), {
        ready: false,
        async connect() {
          this.ready = true;
        },
        close() {
          this.ready = false;
        },
      }),
  });
  t.after(() => runtime.close());
  await runtime.start();
  const original = runtime.child;
  t.after(() => {
    try {
      original.kill("SIGKILL");
    } catch {}
  });
  runtime.client.ready = false;
  runtime.setState({ availability: "failed", diagnostic: "CONNECTION_LOST" });
  await runtime.start();
  assert.notEqual(runtime.child.pid, original.pid);
  assert.throws(() => process.kill(original.pid, 0), { code: "ESRCH" });
  const replacement = runtime.child;
  await runtime.close();
  assert.throws(() => process.kill(replacement.pid, 0), { code: "ESRCH" });
});

test("offline provider preparation finishes before spawn and cancellation cannot launch afterward", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-prepare-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let entered, release;
  const waiting = new Promise((r) => (entered = r));
  const held = new Promise((r) => (release = r));
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => ({
      nodePath: process.execPath,
      entryPath: "unused",
      version: "fixture",
    }),
    spawn: () => assert.fail("spawned before preparation/cancel check"),
  });
  runtime.beforeSpawn = async () => {
    entered();
    await held;
  };
  const starting = runtime.start();
  await Promise.race([waiting, starting]);
  await runtime.stop();
  release();
  await starting;
  assert.equal(runtime.status().availability, "disabled");
});

const until = async (predicate, timeoutMs = 10000) => {
  for (const end = Date.now() + timeoutMs; !predicate();) {
    if (Date.now() > end) assert.fail("condition not reached");
    await new Promise((r) => setTimeout(r, 10));
  }
};
function lifecycleFixture(t, prefix, source = "setInterval(() => {}, 1000)") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entryPath = path.join(dataDir, "gateway.mjs");
  fs.writeFileSync(entryPath, source);
  return {
    dataDir,
    install: async () => ({ nodePath: process.execPath, entryPath, version: "fixture" }),
  };
}

test("a connection lost after five reconnects restarts the Gateway process", async (t) => {
  const { dataDir, install } = lifecycleFixture(t, "assistant-connection-lost-");
  const clients = [];
  const runtime = new RuntimeSupervisor({
    dataDir,
    install,
    timing: { reconnectMs: 1, restartMs: 1 },
    clientFactory: () => {
      const client = Object.assign(new EventEmitter(), {
        ready: false,
        connects: 0,
        async connect() {
          if (this.lost) throw Object.assign(Error("gone"), { code: "UNAVAILABLE" });
          this.connects++;
          this.ready = true;
        },
        close() {
          this.ready = false;
        },
      });
      clients.push(client);
      return client;
    },
  });
  t.after(() => runtime.close());
  const diagnostics = [];
  runtime.on("status", (status) => diagnostics.push(status.diagnostic));
  await runtime.start();
  const original = runtime.child;
  const exited = once(original, "exit");
  clients[0].lost = true;
  clients[0].ready = false;
  clients[0].emit("disconnected");
  await exited;
  assert.ok(diagnostics.includes("CONNECTION_LOST"));
  await until(() => runtime.status().availability === "ready" && clients.length === 2);
  assert.notEqual(runtime.child.pid, original.pid);
  assert.equal(clients[1].connects, 1);
});

test("exhausted crash restarts stay failed with RESTART_LIMIT until restarted", async (t) => {
  const { dataDir, install } = lifecycleFixture(
    t,
    "assistant-restart-limit-",
    "process.exit(1)",
  );
  let spawned = 0;
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => {
      spawned++;
      return install();
    },
    timing: { restartMs: 1 },
    clientFactory: () => ({
      ready: false,
      connect: async () => {
        throw Object.assign(Error("down"), { code: "UNAVAILABLE" });
      },
      close() {},
    }),
  });
  t.after(() => runtime.close());
  await assert.rejects(runtime.start());
  await until(() => runtime.status().diagnostic === "RESTART_LIMIT" && !runtime.starting);
  assert.equal(spawned, 6);
  assert.equal(runtime.status().availability, "failed");
  await assert.rejects(runtime.restart());
  await until(() => runtime.status().diagnostic === "RESTART_LIMIT" && !runtime.starting);
  assert.equal(spawned, 12);
});

test("the console log is private, rotated at 10 MiB and OpenClaw logs only warnings", async (t) => {
  const { dataDir, install } = lifecycleFixture(t, "assistant-console-log-");
  const runtime = new RuntimeSupervisor({
    dataDir,
    install,
    clientFactory: () =>
      Object.assign(new EventEmitter(), { connect: async () => {}, close() {} }),
  });
  t.after(() => runtime.close());
  const log = path.join(runtime.paths.logs, "gateway-console.log");
  fs.writeFileSync(log, "x");
  fs.truncateSync(log, consoleLogLimit.maxBytes);
  fs.chmodSync(log, 0o644);
  for (const index of [1, 2]) fs.writeFileSync(`${log}.${index}`, `old ${index}`);
  await runtime.start();
  assert.equal(consoleLogLimit.maxBytes, 10 * 1024 * 1024);
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
  assert.ok(fs.statSync(log).size < consoleLogLimit.maxBytes);
  assert.equal(fs.statSync(`${log}.1`).size, consoleLogLimit.maxBytes);
  assert.equal(fs.statSync(`${log}.1`).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(`${log}.2`, "utf8"), "old 1");
  assert.equal(fs.existsSync(`${log}.3`), false);
  const config = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8"));
  assert.equal(config.logging.level, "warn");
  assert.equal(config.logging.consoleLevel, "warn");
  assert.equal(config.logging.maxFileBytes, 10 * 1024 * 1024);
  assert.deepEqual(config.diagnostics.flags, []);
  assert.equal(config.diagnostics.otel.captureContent, false);
  assert.equal(config.diagnostics.otel.enabled, false);
  assert.equal(config.diagnostics.cacheTrace.enabled, false);
});

function fakeGateway(t, prefix, options) {
  const fixture = lifecycleFixture(
    t,
    prefix,
    `import { runFakeGateway } from ${JSON.stringify(
      path.resolve("tests/helpers/assistant-fake-gateway.js"),
    )};\nrunFakeGateway(${JSON.stringify(options || {})});`,
  );
  return fixture;
}

test("the Gateway serves loopback TLS with a private, pinned and rotated certificate", async (t) => {
  const { dataDir, install } = fakeGateway(t, "assistant-gateway-tls-");
  const runtime = new RuntimeSupervisor({ dataDir, install });
  t.after(() => runtime.close());
  await runtime.start();
  const config = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8"));
  const { tls } = config.gateway;
  assert.equal(tls.enabled, true);
  assert.equal(tls.autoGenerate, false);
  assert.equal(path.dirname(tls.certPath), path.join(runtime.paths.root, "tls"));
  assert.equal(fs.statSync(path.dirname(tls.certPath)).mode & 0o777, 0o700);
  for (const file of [tls.certPath, tls.keyPath])
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(runtime.client.url, /^wss:\/\/127\.0\.0\.1:\d+$/);
  assert.deepEqual(await runtime.client.call("anything"), { value: 42 });
  const first = fs.readFileSync(tls.certPath, "utf8");
  await runtime.restart();
  assert.notEqual(fs.readFileSync(tls.certPath, "utf8"), first);
  assert.deepEqual(await runtime.client.call("anything"), { value: 42 });
});

test("an impostor on the Gateway port never receives the token", async (t) => {
  const { dataDir } = lifecycleFixture(t, "assistant-gateway-impostor-");
  const record = path.join(dataDir, "impostor.log");
  const { install } = fakeGateway(t, "assistant-gateway-impostor-entry-", {
    impostor: true,
    record,
  });
  const runtime = new RuntimeSupervisor({
    dataDir,
    install,
    timing: { restartMs: 60000 },
  });
  t.after(() => runtime.close());
  await assert.rejects(runtime.start(), { code: "ENDPOINT_UNTRUSTED" });
  const token = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8")).gateway.auth
    .token;
  const received = fs.existsSync(record) ? fs.readFileSync(record, "utf8") : "";
  assert.equal(received.includes(token), false);
  assert.equal(received.includes("connect"), false);
  assert.equal(runtime.status().diagnostic, "ENDPOINT_UNTRUSTED");
  assert.ok(runtime.retryTimer, "a fresh port is tried after the backoff");
});

test("a port taken before the Gateway binds is abandoned for a fresh one with a diagnostic", async (t) => {
  const { dataDir, install } = fakeGateway(t, "assistant-gateway-occupied-");
  const received = [];
  const squatter = tls.createServer(issueGatewayCertificate(), (socket) =>
    socket.on("data", (bytes) => received.push(bytes)),
  );
  squatter.on("tlsClientError", () => {});
  t.after(() => new Promise((r) => squatter.close(r)));
  const runtime = new RuntimeSupervisor({ dataDir, install, timing: { restartMs: 1 } });
  t.after(() => runtime.close());
  const ports = [];
  // Another local process grabs the probed port between selection and the bind.
  runtime.beforeSpawn = async () => {
    const { port } = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8")).gateway;
    ports.push(port);
    if (ports.length === 1)
      await new Promise((r) => squatter.listen(port, "127.0.0.1", r));
  };
  const diagnostics = [];
  runtime.on("status", ({ diagnostic }) => diagnostic && diagnostics.push(diagnostic));
  await assert.rejects(runtime.start(), ({ code }) =>
    ["ENDPOINT_UNTRUSTED", "PROCESS_EXIT"].includes(code),
  );
  assert.ok(
    diagnostics.some((code) => ["ENDPOINT_UNTRUSTED", "PROCESS_EXIT"].includes(code)),
  );
  await until(() => runtime.status().availability === "ready");
  assert.equal(ports.length, 2);
  assert.notEqual(ports[1], ports[0]);
  assert.equal(runtime.client.url, `wss://127.0.0.1:${ports[1]}`);
  assert.deepEqual(await runtime.client.call("anything"), { value: 42 });
  const token = JSON.parse(fs.readFileSync(runtime.paths.config, "utf8")).gateway.auth
    .token;
  assert.equal(Buffer.concat(received).includes(token), false);
});
