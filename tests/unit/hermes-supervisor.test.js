import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { alive, eventually, hermesFakeRuntime } from "../helpers/hermes-fake-runtime.js";
import { HermesSupervisor } from "../../server/features/assistants/runtimes/hermes/hermes-supervisor.js";
import { createHermesAgentHost } from "../../server/features/assistants/runtimes/hermes/hermes-host.js";
import { clientOf } from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { hermesEnvironment } from "../../server/features/assistants/runtimes/hermes/hermes-environment.js";
import { HOST_AVAILABILITY } from "../../server/features/assistants/runtimes/agent-runtime.js";

function supervised(t, fake, options = {}) {
  const { supervisor, host } = createHermesAgentHost({
    dataDir: fake.dataDir,
    agentId: "agent-1",
    runtime: async () => fake.runtime,
    environment: {
      HOME: "/Users/owner",
      AGENTPIER_TOKEN: "secret",
      OPENAI_API_KEY: "owner-key",
      HTTPS_PROXY: "http://proxy.test:3128",
      PATH: "/opt/homebrew/bin:/usr/bin:/bin",
    },
    pathPrepend: ["/agentpier/tools/bin"],
    stopTimeoutMs: 3000,
    backoff: { initialMs: 20, maxMs: 80 },
    ...options,
  });
  t.after(() => supervisor.stop());
  return { supervisor, host };
}

test("a start runs the foreground gateway and the RPC bridge in a private environment", async (t) => {
  const fake = hermesFakeRuntime(t);
  const { supervisor, host } = supervised(t, fake);
  const seen = [];
  host.subscribe((status) => seen.push(status.availability));
  assert.equal(host.ready(), false);
  assert.equal(host.connection(), null);
  await host.start();
  assert.equal(host.ready(), true);
  assert.deepEqual(seen, ["installing", "starting", "ready"]);
  assert.deepEqual(host.status(), {
    availability: "ready",
    sync: null,
    version: "fake-hermes",
    diagnostic: null,
  });
  assert.ok(seen.every((state) => HOST_AVAILABILITY.includes(state)));
  const [start] = fake.starts("agent-1");
  // Foreground, owned by AgentPier, never ending itself when idle.
  assert.deepEqual(start.argv, ["gateway", "run", "--external-supervisor"]);
  const agent = supervisor.agentPaths();
  assert.equal(start.env.HOME, agent.home);
  assert.equal(start.env.HERMES_HOME, agent.hermesHome);
  assert.equal(start.env.TMPDIR, agent.tmp);
  assert.equal(start.env.HTTPS_PROXY, "http://proxy.test:3128");
  assert.match(start.env.LANG, /UTF-8$/);
  assert.equal(
    start.env.PATH,
    [
      path.dirname(fake.runtime.pythonPath),
      "/agentpier/tools/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
  );
  for (const name of ["AGENTPIER_TOKEN", "OPENAI_API_KEY"])
    assert.equal(start.env[name], undefined);
  for (const value of Object.values(start.env))
    assert.doesNotMatch(value, /\/Users\/owner/);
  // Each process leads its own group, so stop can end everything below it.
  const [gateway, bridge] = supervisor.pids();
  assert.deepEqual(fake.bridges("agent-1")[0].argv.slice(0, 1), ["-I"]);
  for (const pid of [gateway, bridge]) assert.equal(alive(-pid), true);
  // The connection is the start's JSON-RPC client, connected over the bridge.
  const client = clientOf(host.connection());
  assert.equal(client, supervisor.client);
  assert.deepEqual(client.capabilities, { method: "client.capabilities" });
  assert.deepEqual(await client.call("session.list", {}), { method: "session.list" });
});

test("stop ends both process groups, descendants included, and nothing stays", async (t) => {
  const fake = hermesFakeRuntime(t);
  const { supervisor, host } = supervised(t, fake);
  await host.start();
  const pids = supervisor.pids();
  const grandchild = fake.grandchild("agent-1");
  const connection = host.connection();
  let dropped = 0;
  host.onDisconnect(connection, () => dropped++);
  await assert.rejects(host.assertStopped(), { code: "HERMES_RUNNING" });
  const socket = fs.readFileSync(
    path.join(fake.home("agent-1"), "gateway.sock.path"),
    "utf8",
  );
  assert.ok(fs.existsSync(socket));
  await host.stop();
  // The killed gateway's control socket folder is gone with it.
  assert.equal(fs.existsSync(path.dirname(socket)), false);
  assert.equal(host.status().availability, "disabled");
  assert.equal(host.connected(connection), false);
  assert.equal(dropped, 1);
  for (const pid of [...pids, grandchild]) assert.equal(alive(pid), false, String(pid));
  await host.assertStopped();
  assert.equal(host.restartNeeded(), false);
});

test("a crash ends the set and restarts it with a new connection and generation", async (t) => {
  const fake = hermesFakeRuntime(t);
  const { supervisor, host } = supervised(t, fake);
  await host.start();
  const first = { connection: host.connection(), generation: host.generation() };
  const [gateway, bridge] = supervisor.pids();
  const states = [];
  host.subscribe((status) => states.push(status.availability));
  process.kill(gateway, "SIGKILL");
  await eventually(
    () => host.ready() && host.connection() !== first.connection,
    10000,
    "restart",
  );
  assert.equal(alive(bridge), false);
  assert.ok(states.includes("reconnecting"));
  assert.equal(host.status().availability, "ready");
  assert.equal(host.connected(first.connection), false);
  assert.notEqual(host.generation(), first.generation);
  assert.equal(fake.starts("agent-1").length, 2);
  assert.ok(await supervisor.client.call("gateway.capabilities", {}));
  assert.equal(clientOf(first.connection).closed, true);
});

test("a set that never gets ready backs off and gives up as failed", async (t) => {
  const fake = hermesFakeRuntime(t);
  fs.mkdirSync(fake.home("agent-1"), { recursive: true });
  fake.flag("agent-1", "fake-gateway-exit");
  const delays = [];
  const timers = {
    setTimeout: (fn, ms, ...args) => {
      if (ms <= 80) delays.push(ms);
      return setTimeout(fn, ms, ...args);
    },
    clearTimeout,
  };
  const { host } = supervised(t, fake, { maxFailures: 3, timers });
  await assert.rejects(host.start(), { code: "HERMES_START_FAILED" });
  await eventually(() => host.status().availability === "failed", 10000, "failed");
  assert.equal(host.status().diagnostic, "HERMES_START_FAILED");
  assert.deepEqual(delays.slice(0, 2), [20, 40]);
  assert.equal(fake.starts("agent-1").length, 3);
  // The owner's next start tries again, and works once the cause is gone.
  fake.flag("agent-1", "fake-gateway-exit", false);
  await host.start();
  assert.equal(host.ready(), true);
});

test("a bridge that never reports gateway.ready times out and ends the set", async (t) => {
  const fake = hermesFakeRuntime(t);
  fs.mkdirSync(fake.home("agent-1"), { recursive: true });
  fake.flag("agent-1", "fake-bridge-silent");
  const { supervisor, host } = supervised(t, fake, {
    readyTimeoutMs: 1500,
    maxFailures: 1,
  });
  await assert.rejects(host.start(), { code: "HERMES_START_TIMEOUT" });
  assert.equal(host.status().availability, "failed");
  assert.deepEqual(supervisor.pids(), []);
  const [start] = fake.starts("agent-1");
  assert.equal(alive(start.pid), false);
});

test("a gateway Hermes started on its own for the home is ended before a start", async (t) => {
  const fake = hermesFakeRuntime(t);
  const { supervisor, host } = supervised(t, fake);
  const agent = supervisor.agentPaths();
  // What `hermes cron run` leaves when no owner runs: a detached gateway in its own session.
  const stray = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", "gateway", "run", "--idle-exit"],
    {
      detached: true,
      stdio: "ignore",
    },
  );
  t.after(() => alive(stray.pid) && process.kill(stray.pid, "SIGKILL"));
  fs.writeFileSync(
    path.join(agent.hermesHome, "gateway.lock"),
    JSON.stringify({
      pid: stray.pid,
      kind: "hermes-gateway",
      hermes_home: agent.hermesHome,
    }),
  );
  await host.start();
  await eventually(() => !alive(stray.pid), 5000, "stray gateway ended");
  // A lock naming another home, or a process that is no gateway, is left alone.
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: "ignore",
  });
  t.after(() => alive(other.pid) && process.kill(other.pid, "SIGKILL"));
  fs.writeFileSync(
    path.join(agent.hermesHome, "gateway.lock"),
    JSON.stringify({ pid: other.pid, hermes_home: agent.hermesHome }),
  );
  await host.stop();
  assert.equal(alive(other.pid), true);
});

test("stop during a start ends what the start spawned; a start waits for a stop", async (t) => {
  const fake = hermesFakeRuntime(t);
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const { supervisor, host } = supervised(t, fake, {
    runtime: async () => (await gate, fake.runtime),
  });
  const starting = host.start();
  await eventually(() => host.status().availability === "installing", 2000, "installing");
  const stopping = host.stop();
  release();
  await Promise.all([starting, stopping]);
  assert.equal(host.status().availability, "disabled");
  assert.equal(fake.starts("agent-1").length, 0);
  await host.start();
  const pids = supervisor.pids();
  const stopped = host.stop();
  const restarted = host.start();
  await stopped;
  await restarted;
  assert.equal(host.ready(), true);
  for (const pid of pids) assert.equal(alive(pid), false);
});

test("lifecycle: restart reasons follow the starts; Hermes migrates nothing itself", async (t) => {
  const fake = hermesFakeRuntime(t);
  const { host } = supervised(t, fake);
  assert.equal(host.restartNeeded(), false);
  await host.start();
  assert.equal(host.restartNeeded(), true);
  const first = host.generation();
  await host.restart();
  assert.notEqual(host.generation(), first);
  assert.equal(host.current(null), false);
  assert.equal(host.sameInstall(null, null), false);
  assert.equal(typeof host.target().version, "string");
  await host.migrate();
  await host.stopMigration(null);
  assert.deepEqual(host.loopbackPorts(), []);
});

test("the environment refuses AgentPier and Hermes control variables", () => {
  const agent = { home: "/a/home", hermesHome: "/a/state", tmp: "/a/tmp" };
  const runtime = { pythonPath: "/r/venv/bin/python" };
  for (const name of [
    "AGENTPIER_TOKEN",
    "HERMES_YOLO_MODE",
    "XPC_SERVICE_NAME",
    "bad-name",
  ])
    assert.throws(() => hermesEnvironment({ agent, runtime, extra: { [name]: "1" } }), {
      code: "HERMES_ENVIRONMENT_REFUSED",
    });
  const env = hermesEnvironment({
    agent,
    runtime,
    extra: { BRAVE_API_KEY: "k" },
    parent: {},
  });
  assert.equal(env.BRAVE_API_KEY, "k");
  assert.equal(env.XDG_CONFIG_HOME, "/a/home/.config");
  assert.equal(env.PYTHONNOUSERSITE, "1");
});

test("the supervisor class reports no version while stopped", (t) => {
  const fake = hermesFakeRuntime(t);
  const supervisor = new HermesSupervisor({ dataDir: fake.dataDir, agentId: "agent-2" });
  assert.deepEqual(supervisor.status(), {
    availability: "disabled",
    sync: null,
    version: null,
    diagnostic: null,
  });
  assert.equal(supervisor.transport, null);
  assert.equal(supervisor.client, null);
});
