import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runtimePaths } from "./runtime-paths.js";
import { selectedAssistantRuntime } from "./runtime-install.js";
import { prepareRuntimeConfig, runtimeEnvironment } from "./runtime-config.js";
import { GatewayClient } from "./gateway-client.js";
import { prepareGatewayTls } from "./gateway-tls.js";
import { openConsoleLog, rotateConsoleLog } from "./gateway-log.js";
import { reclaimOwner, recordOwner } from "./gateway-ownership.js";
import { processIdentity } from "../../lib/process-identity.js";
import { assertWired } from "./service-wiring.js";

// Errors an unattended retry cannot fix; they wait for the owner instead.
const terminal = new Set([
  "INVALID_CONFIG",
  "UNAUTHORIZED",
  "PROTOCOL_MISMATCH",
  "OWNERSHIP_CONFLICT",
  "ASSISTANT_STORAGE_UNSAFE",
  "RUNTIME_LOCK_MISSING",
]);

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  return port;
}
export class RuntimeSupervisor extends EventEmitter {
  constructor({
    dataDir,
    install = selectedAssistantRuntime,
    spawn = spawnProcess,
    clientFactory = (options) => new GatewayClient(options),
    identity = processIdentity,
    timing = {},
  }) {
    super();
    Object.assign(this, { dataDir, install, spawn, clientFactory, identity });
    this.timing = {
      reconnectMs: 1000,
      restartMs: 1000,
      killGraceMs: 3000,
      logCheckMs: 60000,
      // Authenticated readiness is a wall-clock budget, never an attempt count:
      // refused probes return instantly, so a count shrinks with fast failures.
      // The floor covers a cold start on slow hosts (a fresh install took ~22 s on
      // hosted Intel macOS); a host that took longer before gets proportionally more,
      // since a restart also loads the agents and sessions created meanwhile.
      readyMs: 90000,
      readyFactor: 3,
      readyPollMs: 250,
      ...timing,
    };
    this.paths = runtimePaths(dataDir);
    this.ownerPath = path.join(this.paths.root, "owner.json");
    this.generation = 0;
    this.attempts = 0;
    this.state = {
      availability: "disabled",
      sync: "stale",
      version: null,
      diagnostic: null,
    };
  }
  status() {
    return { ...this.state };
  }
  /**
   * Update paths require a stopped Gateway. Our own verified orphan (left by an
   * earlier AgentPier process) is retired; a foreign or unverifiable owner conflicts.
   */
  async assertStopped() {
    if (this.child && this.child.exitCode === null)
      throw Object.assign(Error("Assistant runtime is still running."), {
        code: "OWNERSHIP_CONFLICT",
      });
    if (fs.existsSync(this.ownerPath))
      await reclaimOwner(this.ownerPath, {
        identity: this.identity,
        graceMs: this.timing.killGraceMs,
      });
  }
  setState(patch) {
    Object.assign(this.state, patch);
    this.emit("status", this.status());
  }
  start({ automatic = false } = {}) {
    assertWired(this);
    if (this.stopping) return this.stopping.then(() => this.start({ automatic }));
    if (this.starting) return this.starting;
    if (this.client?.ready) return Promise.resolve();
    // An owner's explicit start after exhausted retries grants a fresh budget.
    if (!automatic && this.state.diagnostic === "RESTART_LIMIT") this.attempts = 0;
    const generation = ++this.generation;
    this.wanted = true;
    this.starting = this.launch(generation)
      .catch(async (error) => {
        if (this.generation === generation) {
          if (this.child) await this.stop();
          this.setState({
            availability: "failed",
            diagnostic: error.code || "START_FAILED",
          });
          if (
            (automatic || error.code === "ENDPOINT_UNTRUSTED") &&
            !terminal.has(error.code)
          ) {
            this.wanted = true;
            this.scheduleRestart();
          }
        }
        throw error;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }
  async launch(generation) {
    if (this.child) {
      this.client?.close();
      await this.terminateOwnedChild();
      if (generation !== this.generation) return;
    }
    const ownerPath = this.ownerPath;
    // An earlier AgentPier process may have died without stopping its Gateway (for
    // example under systemd's KillMode=process); reclaim it before binding again.
    if (!this.child && fs.existsSync(ownerPath)) {
      await reclaimOwner(ownerPath, {
        identity: this.identity,
        graceMs: this.timing.killGraceMs,
      });
      if (generation !== this.generation) return;
    }
    this.setState({ availability: "installing", diagnostic: null, sync: "stale" });
    const runtime = await this.install({ dataDir: this.dataDir });
    if (generation !== this.generation) return;
    if (runtime.diagnostic) this.setState({ diagnostic: runtime.diagnostic });
    const port = await freePort();
    if (generation !== this.generation) return;
    const teams = this.teamConfiguration
      ? await this.teamConfiguration(runtime)
      : undefined;
    if (generation !== this.generation) return;
    const tls = prepareGatewayTls(this.paths);
    const token = prepareRuntimeConfig(this.paths, port, teams, {
      maintenance: !!this.maintenance?.(),
      tls,
    });
    await this.beforeSpawn?.();
    if (generation !== this.generation) return;
    this.setState({ availability: "starting", version: runtime.version });
    const logPath = path.join(this.paths.logs, "gateway-console.log");
    const log = openConsoleLog(logPath);
    let child;
    try {
      child = this.child = this.spawn(
        runtime.nodePath,
        [
          runtime.entryPath,
          "gateway",
          "run",
          "--bind",
          "loopback",
          "--port",
          String(port),
        ],
        {
          cwd: this.paths.root,
          env: runtimeEnvironment(this.paths, runtime.nodePath, token),
          stdio: ["ignore", log, log],
        },
      );
    } finally {
      fs.closeSync(log);
    }
    const logTimer = setInterval(() => {
      try {
        rotateConsoleLog(logPath);
      } catch {
        /* Retried on the next interval and at the next start. */
      }
    }, this.timing.logCheckMs);
    logTimer.unref();
    child.on("error", () => {
      clearInterval(logTimer);
      this.setState({ availability: "failed", diagnostic: "PROCESS_START" });
    });
    if (child.pid) recordOwner(ownerPath, child.pid, runtime, this.identity);
    child.once("exit", (code) => {
      clearInterval(logTimer);
      if (this.child !== child) return;
      this.child = null;
      this.client?.close();
      clearTimeout(this.healthyTimer);
      fs.rmSync(ownerPath, { force: true });
      if (this.wanted && generation === this.generation) {
        this.setState({
          availability: "failed",
          diagnostic: code === 78 ? "INVALID_CONFIG" : child.retired || "PROCESS_EXIT",
          sync: "stale",
        });
        if (code !== 78) this.scheduleRestart();
      }
    });
    const client = (this.client = this.clientFactory({
      url: `wss://127.0.0.1:${port}`,
      token,
      certPath: tls.certPath,
    }));
    const spawned = Date.now();
    const deadline =
      spawned +
      Math.max(this.timing.readyMs, this.timing.readyFactor * (this.lastReadyMs || 0));
    while (generation === this.generation) {
      if (child.exitCode !== null)
        throw Object.assign(Error("Assistant Gateway exited."), {
          code: child.exitCode === 78 ? "INVALID_CONFIG" : "PROCESS_EXIT",
        });
      try {
        await client.connect();
        break;
      } catch (error) {
        // ENDPOINT_UNTRUSTED: something else answers on the probed port without our
        // certificate. The token was not sent; retry on a fresh port instead.
        if (
          ["UNAUTHORIZED", "PROTOCOL_MISMATCH", "ENDPOINT_UNTRUSTED"].includes(error.code)
        )
          throw error;
        if (Date.now() + this.timing.readyPollMs >= deadline) throw error;
        await delay(this.timing.readyPollMs);
      }
    }
    if (generation !== this.generation) {
      client.close();
      return;
    }
    this.lastReadyMs = Date.now() - spawned;
    await this.afterReady?.();
    if (generation !== this.generation) return;
    this.setState({ availability: "ready", sync: "reconciling" });
    client.on("disconnected", () => {
      if (
        this.wanted &&
        generation === this.generation &&
        this.child === child &&
        !this.reconnecting
      )
        this.reconnect(generation, client, child);
    });
    this.healthyTimer = setTimeout(() => {
      this.attempts = 0;
    }, 60000);
    this.healthyTimer.unref();
  }
  async reconnect(generation, client, child) {
    this.reconnecting = true;
    this.setState({ availability: "reconnecting", sync: "stale" });
    try {
      for (let n = 0; n < 5 && this.wanted && generation === this.generation; n++) {
        await delay(this.timing.reconnectMs * 2 ** n, undefined, { ref: false });
        if (!this.wanted || generation !== this.generation) return;
        try {
          await client.connect();
          this.setState({ availability: "ready", sync: "reconciling" });
          return;
        } catch {
          /* Bounded retry; no request replay. */
        }
      }
      if (this.wanted && generation === this.generation && this.child === child) {
        // A live process that no longer accepts us is restarted; its exit schedules
        // the replacement through the same bounded crash backoff.
        this.setState({ availability: "failed", diagnostic: "CONNECTION_LOST" });
        child.retired = "CONNECTION_LOST";
        client.close();
        await this.terminateOwnedChild();
      }
    } finally {
      this.reconnecting = false;
    }
  }
  scheduleRestart() {
    if (this.retryTimer) return;
    if (this.attempts >= 5) {
      this.setState({ availability: "failed", diagnostic: "RESTART_LIMIT" });
      return;
    }
    // A crash can be observed while its launch is still settling; retry after it.
    const run = () => {
      if (!this.wanted) return;
      if (this.starting) this.starting.catch(() => {}).then(run);
      else this.start({ automatic: true }).catch(() => {});
    };
    this.retryTimer = setTimeout(
      () => {
        this.retryTimer = null;
        run();
      },
      this.timing.restartMs * 2 ** this.attempts++,
    );
    this.retryTimer.unref();
  }
  async terminateOwnedChild() {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode) return;
    const exited = once(child, "exit").catch(() => {});
    const kill = setTimeout(() => child.kill("SIGKILL"), this.timing.killGraceMs);
    child.kill("SIGTERM");
    await exited;
    clearTimeout(kill);
  }
  stop() {
    if (this.stopping) return this.stopping;
    this.wanted = false;
    ++this.generation;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearTimeout(this.healthyTimer);
    this.client?.close();
    if (this.child) this.setState({ availability: "stopping" });
    this.stopping = this.terminateOwnedChild()
      .then(() => {
        this.setState({ availability: "disabled", sync: "stale" });
      })
      .finally(() => {
        this.stopping = null;
      });
    return this.stopping;
  }
  async restart() {
    await this.stop();
    this.attempts = 0;
    await this.start();
  }
  close() {
    return this.stop();
  }
}
