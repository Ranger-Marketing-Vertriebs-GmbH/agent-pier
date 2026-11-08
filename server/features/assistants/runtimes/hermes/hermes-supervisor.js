import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { execFileSync, spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readJSON } from "../../../../lib/storage.js";
import { hermesAgentPaths, hermesPaths } from "./hermes-paths.js";
import { hermesEnvironment } from "./hermes-environment.js";
import { selectedHermesRuntime } from "./hermes-install.js";
import { rpcTransport, stdioTransport } from "./hermes-transport.js";
import { createHermesClient } from "./hermes-connection.js";

export const hermesBridgeFile = fileURLToPath(
  new URL("./hermes-rpc-bridge.py", import.meta.url),
);
const stableCode = (error, fallback) =>
  /^[A-Z][A-Z0-9_]*$/.test(error?.code || "") ? error.code : fallback;
const failure = (code) => Object.assign(Error(code), { code, status: 503 });
const alive = (pid, kill) => {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
};
const signal = (pid, name, kill) => {
  try {
    kill(pid, name);
  } catch {
    /* Already gone. */
  }
};
const commandOf = (pid) => {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
      timeout: 5000,
    });
  } catch {
    return "";
  }
};

/**
 * One Hermes agent's supervised process set (ADR 0006, decision 4), with its own
 * HOME, HERMES_HOME and TMPDIR under `<data>/assistants/hermes/` (hermes-paths.js):
 *
 * 1. `hermes gateway run --external-supervisor`, the messaging gateway, in the
 *    foreground: it owns the home (Hermes's gateway.lock), runs routines and
 *    channels, hosts the agent's sessions, and with `--external-supervisor` a chat
 *    `/restart` or `hermes update` exits back here instead of spawning a detached
 *    replacement. It never gets `--idle-exit`, so it never ends itself while idle.
 * 2. The RPC bridge (hermes-rpc-bridge.py): Hermes refuses `python -m
 *    tui_gateway.entry` on a home a gateway owns, so the bridge attaches to the
 *    gateway's TUI JSON-RPC listener with a session ticket from the owner-only
 *    control socket and relays it over its stdin and stdout, the `transport`.
 *    Each start builds a new JSON-RPC client over it (hermes-connection.js
 *    createHermesClient), `client`, and becomes ready once that client is
 *    connected; a stop or crash closes it, so a restart is a new connection.
 *
 * `prepare(agentPaths)` runs before each start, once the installation is known and
 * before any process of the set: the runtime (hermes-runtime.js) writes the agent's
 * compiled HERMES_HOME there and may set `timezone`, the HERMES_TIMEZONE the set's
 * processes get (hermes-environment.js; null: none).
 *
 * Hermes starts a gateway of its own only when a client finds no owner (`hermes cron
 * run`, `hermes chat`, …, through ensure_gateway_runtime with `--idle-exit`, on macOS
 * as a one-off launchd job via osascript). While the set runs, every such client
 * attaches to this gateway; before a start and after a stop, a gateway that still
 * owns the home is ended (sweep). Each process runs in its own process group; stop
 * ends both groups. A crash ends the set and restarts it with a growing pause; after
 * `maxFailures` starts in a row that never got ready, the set stays `failed` until
 * the next start().
 *
 * status(): `{ availability, sync, version, diagnostic }`, availability one of
 * HOST_AVAILABILITY (../agent-runtime.js); events "status" on each change.
 */
export class HermesSupervisor extends EventEmitter {
  constructor({
    dataDir,
    agentId,
    runtime = selectedHermesRuntime,
    spawn = spawnProcess,
    kill = process.kill.bind(process),
    command = commandOf,
    environment = process.env,
    pathPrepend = [],
    extra = {},
    timezone = null,
    bridge = hermesBridgeFile,
    prepare = async () => {},
    callTimeoutMs = 30000,
    readyTimeoutMs = 120000,
    stopTimeoutMs = 10000,
    backoff = { initialMs: 1000, maxMs: 30000 },
    stableMs = 60000,
    maxFailures = 5,
    timers = { setTimeout, clearTimeout },
    now = Date.now,
  }) {
    super();
    Object.assign(this, { dataDir, agentId, runtime, spawn, kill, command, environment });
    Object.assign(this, { pathPrepend, extra, bridge, readyTimeoutMs, stopTimeoutMs });
    Object.assign(this, { prepare, callTimeoutMs, timezone });
    Object.assign(this, { backoff, stableMs, maxFailures, timers, now });
    this.availability = "disabled";
    this.diagnostic = null;
    this.version = null;
    this.generationId = null;
    this.current = null;
    this.wanted = false;
    this.failures = 0;
    this.timer = null;
    this.starting = null;
    this.stopping = null;
  }
  status() {
    return {
      availability: this.availability,
      sync: null,
      version: this.availability === "disabled" ? null : this.version,
      diagnostic: this.diagnostic,
    };
  }
  set(availability, diagnostic = null) {
    if (this.availability === availability && this.diagnostic === diagnostic) return;
    Object.assign(this, { availability, diagnostic });
    this.emit("status", this.status());
  }
  /** The channel of the running set (hermes-transport.js), or null. */
  get transport() {
    return this.current?.ready ? this.current.transport : null;
  }
  /** The JSON-RPC client of the running set (hermes-rpc-client.js), or null. */
  get client() {
    return this.current?.ready ? this.current.client : null;
  }
  /** The pids of the running set's process groups. */
  pids() {
    return this.current
      ? [this.current.gateway.pid, this.current.bridge.pid].filter(Boolean)
      : [];
  }
  agentPaths() {
    return hermesAgentPaths(hermesPaths(this.dataDir), this.agentId);
  }
  start() {
    // An owner's start after a give-up tries again from the first pause.
    if (this.availability === "failed") this.failures = 0;
    this.wanted = true;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (this.starting) return this.starting;
    if (this.current?.ready) return Promise.resolve(this.status());
    const run = (this.stopping || Promise.resolve()).then(() => this.launch());
    this.starting = run.finally(() => (this.starting = null));
    return this.starting;
  }
  async launch() {
    if (!this.wanted) return this.status();
    this.set("installing");
    let record;
    try {
      record = await this.runtime({ dataDir: this.dataDir });
    } catch (error) {
      this.set("failed", stableCode(error, "HERMES_RUNTIME_UNAVAILABLE"));
      throw error;
    }
    if (!this.wanted) return this.stopped();
    this.version = record.version;
    this.set("starting");
    const agent = this.agentPaths();
    try {
      await this.prepare(agent, record);
    } catch (error) {
      this.set("failed", stableCode(error, "HERMES_PREPARE_FAILED"));
      throw error;
    }
    if (!this.wanted) return this.stopped();
    await this.sweep(agent);
    if (!this.wanted) return this.stopped();
    const env = hermesEnvironment({
      agent,
      runtime: record,
      pathPrepend: this.pathPrepend,
      extra: this.extra,
      timezone: this.timezone,
      parent: this.environment,
    });
    const set = this.spawnSet(record, agent, env);
    this.current = set;
    this.generationId = set.generation;
    let timeout;
    const ready = await Promise.race([
      set.transport.ready.then(() => this.connect(set, agent)),
      set.ended.then(() => false),
      new Promise(
        (resolve) =>
          (timeout = this.timers.setTimeout(resolve, this.readyTimeoutMs, null)),
      ),
    ]);
    this.timers.clearTimeout(timeout);
    if (ready === true && this.current === set) {
      set.ready = true;
      set.readyAt = this.now();
      set.socketFolder = this.controlSocketFolder(agent);
      this.set("ready");
      return this.status();
    }
    if (this.current === set) {
      this.current = null;
      await this.terminate(set);
      const code = ready === null ? "HERMES_START_TIMEOUT" : "HERMES_START_FAILED";
      this.crashed(code);
      throw failure(code);
    }
    // A stop that ended the set meanwhile is no failure of this start.
    if (!this.wanted) return this.status();
    throw failure(this.diagnostic || "HERMES_START_FAILED");
  }
  /**
   * The set's client once the bridge reported gateway.ready: true when it connected
   * (Hermes knows it answers approvals), false when the channel closed first. The
   * agent's commands run in its workspace, which its approval requests name.
   */
  async connect(set, agent) {
    set.client = createHermesClient(rpcTransport(set.transport), {
      agentId: this.agentId,
      timeoutMs: this.callTimeoutMs,
      workspace: agent?.workspace,
    });
    try {
      await set.client.connect({ timeoutMs: this.readyTimeoutMs });
      return true;
    } catch {
      return false;
    }
  }
  spawnSet(record, agent, env) {
    const log = (name) => fs.openSync(path.join(agent.logs, name), "a", 0o600);
    const gatewayLog = log("gateway.log");
    const bridgeLog = log("rpc-bridge.log");
    const options = { cwd: agent.workspace, env, detached: true };
    let gateway, bridge;
    try {
      gateway = this.spawn(
        record.hermesPath,
        ["gateway", "run", "--external-supervisor"],
        {
          ...options,
          stdio: ["ignore", gatewayLog, gatewayLog],
        },
      );
      bridge = this.spawn(
        record.pythonPath,
        ["-I", this.bridge, String(Math.ceil(this.readyTimeoutMs / 1000))],
        { ...options, stdio: ["pipe", "pipe", bridgeLog] },
      );
    } finally {
      fs.closeSync(gatewayLog);
      fs.closeSync(bridgeLog);
    }
    const exits = [gateway, bridge].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) resolve();
          child.once("exit", resolve);
          child.once("error", resolve);
        }),
    );
    const set = {
      generation: randomUUID(),
      gateway,
      bridge,
      transport: stdioTransport(bridge),
      ready: false,
      ended: Promise.race(exits),
      gone: Promise.all(exits),
    };
    set.ended.then(() => this.exited(set));
    return set;
  }
  /** One process of the set ended: the set ends, and restarts while wanted. */
  async exited(set) {
    // A set that never got ready is launch()'s to end.
    if (this.current !== set || !set.ready) return;
    this.current = null;
    const stable = set.ready && this.now() - set.readyAt >= this.stableMs;
    await this.terminate(set);
    if (set.ready) this.crashed("HERMES_EXITED", stable);
  }
  crashed(diagnostic, stable = false) {
    this.failures = stable ? 1 : this.failures + 1;
    if (!this.wanted) return this.stopped();
    if (this.failures >= this.maxFailures) {
      this.wanted = false;
      return this.set("failed", diagnostic);
    }
    this.set("reconnecting", diagnostic);
    const delay = Math.min(
      this.backoff.maxMs,
      this.backoff.initialMs * 2 ** (this.failures - 1),
    );
    this.timer = this.timers.setTimeout(() => {
      this.timer = null;
      if (this.wanted) this.start().catch(() => {});
    }, delay);
  }
  stopped() {
    this.set("disabled");
    return this.status();
  }
  /** Ends both process groups: stdin closes, TERM, and KILL after stopTimeoutMs. */
  async terminate(set) {
    set.client?.close();
    set.transport.close();
    const groups = [set.gateway.pid, set.bridge.pid].filter(Boolean);
    for (const pid of groups) signal(-pid, "SIGTERM", this.kill);
    let timeout;
    await Promise.race([
      set.gone,
      new Promise(
        (resolve) => (timeout = this.timers.setTimeout(resolve, this.stopTimeoutMs)),
      ),
    ]);
    this.timers.clearTimeout(timeout);
    // A leader's descendants can outlive it inside its group.
    for (const pid of groups)
      if (alive(-pid, this.kill)) signal(-pid, "SIGKILL", this.kill);
    await set.gone;
    this.removeControlSocket(set);
  }
  /**
   * A home path longer than a socket path allows makes Hermes bind its control socket
   * as `<tmp>/hermes-gw-<hash>/control.sock` and name it in the home's
   * `gateway.sock.path`; Hermes leaves that folder behind when it ends. The folder
   * of the running set, or null.
   */
  controlSocketFolder(agent) {
    let target;
    try {
      target = fs
        .readFileSync(path.join(agent.hermesHome, "gateway.sock.path"), "utf8")
        .trim();
    } catch {
      return null;
    }
    const folder = path.dirname(target);
    return path.isAbsolute(target) &&
      path.basename(target) === "control.sock" &&
      /^hermes-gw-[0-9a-f]{8,64}$/.test(path.basename(folder))
      ? folder
      : null;
  }
  /** Removes the set's control socket folder once no process of the set runs. */
  removeControlSocket(set) {
    const folder = set.socketFolder || this.controlSocketFolder(this.agentPaths());
    if (!folder) return;
    try {
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()))
        return;
      fs.rmSync(folder, { recursive: true, force: true });
    } catch {
      /* Already gone. */
    }
  }
  /**
   * Ends a gateway that owns this agent's home without being this set's: one Hermes
   * started itself while the set was down. Its lock record names its pid and home.
   */
  async sweep(agent) {
    let record;
    try {
      record = readJSON(path.join(agent.hermesHome, "gateway.lock"), null);
    } catch {
      record = null;
    }
    const pid = record?.pid;
    if (!Number.isSafeInteger(pid) || pid <= 1 || this.pids().includes(pid)) return false;
    if (path.resolve(String(record.hermes_home || "")) !== path.resolve(agent.hermesHome))
      return false;
    if (!alive(pid, this.kill) || !/\bgateway\b/.test(this.command(pid))) return false;
    for (const target of [-pid, pid]) signal(target, "SIGTERM", this.kill);
    const deadline = this.now() + this.stopTimeoutMs;
    while (alive(pid, this.kill) && this.now() < deadline)
      await new Promise((resolve) => this.timers.setTimeout(resolve, 100));
    for (const target of [-pid, pid])
      if (alive(target, this.kill)) signal(target, "SIGKILL", this.kill);
    return true;
  }
  stop() {
    this.wanted = false;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    if (this.stopping) return this.stopping;
    // Only a start from before this stop; a later one waits for this stop.
    const pending = this.starting;
    this.stopping = (async () => {
      if (this.current || this.starting || this.availability !== "disabled")
        this.set("stopping");
      for (let round = 0; round < 2; round++) {
        const set = this.current;
        this.current = null;
        if (set) await this.terminate(set);
        // A start still waiting for its runtime or readiness gives up first.
        await pending?.catch(() => {});
      }
      await this.sweep(this.agentPaths());
      this.failures = 0;
      return this.stopped();
    })().finally(() => (this.stopping = null));
    return this.stopping;
  }
  async restart() {
    await this.stop();
    return this.start();
  }
  /** Rejects while a process of the set (or a gateway owning its home) still runs. */
  async assertStopped() {
    const running = this.current || this.starting;
    if (running) throw failure("HERMES_RUNNING");
  }
}
