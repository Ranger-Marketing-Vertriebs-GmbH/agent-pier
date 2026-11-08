import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createHermesRuntime } from "./hermes-runtime.js";
import { hermesPaths, hermesWorkspace } from "./hermes-paths.js";

// Agent ids that may name a Hermes folder (hermes-paths.js agentId).
const folderId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The runtime agent id of an agent read (`ap-<id>` for one stored without it). */
export const hermesAgentIdOf = (agent) =>
  typeof agent?.runtimeAgentId === "string" && agent.runtimeAgentId
    ? agent.runtimeAgentId
    : typeof agent?.id === "string" && agent.id
      ? `ap-${agent.id}`
      : null;

const isHermes = (agent) => agent?.runtime === "hermes";

/**
 * Every Hermes agent of one AgentPier (ADR 0006 decision 4: one supervised process
 * set per agent, hermes-runtime.js), by runtime agent id. runtime-for.js resolves a
 * Hermes agent's runtime here; the composition root starts and stops the sets with
 * the agents service, the Hermes switch and each agent's lifecycle.
 *
 * - `available()`: whether Hermes may run now (the owner enabled it and a pinned
 *   installation is selected); start() and startAll() start nothing otherwise.
 * - runtimeOf(agent): the agent's AgentRuntime, made once and kept (stopped until a
 *   start); its connection, events and approvals belong to that one set.
 * - start(agent), stop(agent), startAll(agents) (the Hermes agents among them that
 *   are not archived), stopAll(); remove(agent) stops the set and deletes its HOME,
 *   HERMES_HOME, work folder, temporary and log folders.
 * - subscribe(listener): run events of every set, subscribed anew whenever a set
 *   became ready (a start or restart is a new connection); returns unsubscribe.
 * - "status" events `(agentId, status)` on each set's status change.
 *
 * Options: `dataDir`, `available`, `strict(agentId)` (every-command approval of the
 * agent), `version()` (the selected installation's version, installedVersion()),
 * `advanced()` (createHermesRuntime's) and HermesSupervisor's (`runtime`, timeouts, …) for every set; `create`
 * replaces createHermesRuntime (tests).
 */
export class HermesFleet extends EventEmitter {
  constructor({
    dataDir,
    available = () => false,
    strict = () => false,
    version = () => null,
    create = createHermesRuntime,
    ...options
  }) {
    super();
    Object.assign(this, { dataDir, available, strict, version, create, options });
    this.sets = new Map();
    this.listeners = new Set();
    this.closed = false;
  }

  entry(agentId) {
    let entry = this.sets.get(agentId);
    if (entry) return entry;
    if (!folderId.test(agentId || ""))
      throw Object.assign(Error("Invalid Hermes agent id."), { code: "HERMES_AGENT_ID" });
    const made = this.create({
      ...this.options,
      dataDir: this.dataDir,
      agentId,
      strict: () => !!this.strict(agentId),
      remove: () => this.removeFolders(agentId),
    });
    entry = { ...made, agentId, unsubscribe: null, connection: null };
    this.sets.set(agentId, entry);
    made.runtime.host.subscribe((status) => {
      this.follow(entry);
      this.emit("status", agentId, status);
    });
    return entry;
  }

  /** The version of the Hermes installation the next start runs, or null. */
  installedVersion() {
    return this.version() || null;
  }

  /** The AgentRuntime of a Hermes agent read (or its runtime agent id). */
  runtimeOf(agent) {
    const agentId = typeof agent === "string" ? agent : hermesAgentIdOf(agent);
    return this.entry(agentId).runtime;
  }

  /** The runtime of the agent `agentId` names, or null while none was made. */
  known(agentId) {
    return this.sets.get(agentId)?.runtime ?? null;
  }

  /** The work folder of a Hermes agent read (its terminal's cwd), or null. */
  workspaceOf(agent) {
    const agentId = hermesAgentIdOf(agent);
    if (!this.dataDir || !folderId.test(agentId || "")) return null;
    return hermesWorkspace(hermesPaths(this.dataDir), agentId);
  }

  /**
   * The private folders of a Hermes agent read outside its work folder, or null: its
   * HERMES_HOME (sessions, caches, staged and committed chat images) and its HOME.
   */
  privateFoldersOf(agent) {
    const agentId = hermesAgentIdOf(agent);
    if (!this.dataDir || !folderId.test(agentId || "")) return null;
    const paths = hermesPaths(this.dataDir);
    return [path.join(paths.state, agentId), path.join(paths.home, agentId)];
  }

  /** The runtimes made so far, by runtime agent id. */
  list() {
    return [...this.sets.values()].map(({ agentId, runtime }) => ({ agentId, runtime }));
  }

  /** Whether a set of the fleet still runs or starts. */
  running() {
    return [...this.sets.values()].some(
      ({ runtime }) => runtime.host.status().availability !== "disabled",
    );
  }

  // Run events of a set that became ready: one subscription per connection.
  follow(entry) {
    const connection = entry.runtime.host.connection();
    if (connection === entry.connection) return;
    entry.unsubscribe?.();
    entry.unsubscribe = null;
    entry.connection = connection;
    if (!connection || !this.listeners.size) return;
    entry.unsubscribe = entry.runtime.events.subscribe((event) => this.deliver(event));
  }

  deliver(event) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        /* One failing listener must not stop the others. */
      }
    }
  }

  subscribe(listener) {
    this.listeners.add(listener);
    if (this.listeners.size === 1)
      for (const entry of this.sets.values()) {
        entry.connection = null;
        this.follow(entry);
      }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      for (const entry of this.sets.values()) {
        entry.unsubscribe?.();
        entry.unsubscribe = null;
        entry.connection = null;
      }
    };
  }

  /** Starts the set of `agent` while Hermes is available; resolves its status. */
  async start(agent) {
    if (this.closed || !isHermes(agent) || agent.archivedAt || !this.available())
      return null;
    return this.runtimeOf(agent).host.start();
  }

  async stop(agent) {
    const runtime = this.known(hermesAgentIdOf(agent));
    if (runtime) await runtime.host.stop();
  }

  /** Starts every Hermes agent among `agents` that is not archived. */
  async startAll(agents = []) {
    const results = await Promise.allSettled(agents.map((agent) => this.start(agent)));
    return results.filter((r) => r.status === "rejected").length;
  }

  async stopAll() {
    await Promise.allSettled([...this.sets.values()].map((e) => e.runtime.host.stop()));
  }

  /** Stops the set of `agent` and removes its folders (agent deletion). */
  async remove(agent) {
    const agentId = hermesAgentIdOf(agent);
    if (!folderId.test(agentId || "")) return;
    await this.stop(agent);
    this.removeFolders(agentId);
    const entry = this.sets.get(agentId);
    entry?.unsubscribe?.();
    this.sets.delete(agentId);
  }

  removeFolders(agentId) {
    const paths = hermesPaths(this.dataDir);
    for (const name of ["home", "state", "workspaces", "tmp", "logs"])
      fs.rmSync(path.join(paths[name], agentId), { recursive: true, force: true });
    // Its work folder, AgentPier's agent workspace (hermes-paths.js hermesWorkspace).
    fs.rmSync(hermesWorkspace(paths, agentId), { recursive: true, force: true });
  }

  async close() {
    this.closed = true;
    await this.stopAll();
    for (const entry of this.sets.values()) entry.unsubscribe?.();
    this.listeners.clear();
  }
}
