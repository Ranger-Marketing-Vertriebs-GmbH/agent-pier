import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { cleanEnvironment } from "../accounts/account-store.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
import {
  createFrozenServer,
  frozenPreview,
  installFrozen,
  jobSettled,
} from "../mcp-packages/frozen-install.js";
import { reaCore, reaManifest, reaPlatform } from "./rea-manifest.js";
import {
  installReaComponent,
  managedReaComponent,
  removeReaComponent,
} from "./rea-components.js";
import {
  cleanReaSettings,
  prepareReaHome,
  reaEnvPatch,
  reaEnvironment,
  reaManagedKeys,
} from "./rea-environment.js";
import { placeFridaPrebuild } from "./rea-frida.js";
import { syncReaSkills } from "./rea-skills.js";
import { startRea, uninstallRea } from "./rea-lifecycle.js";
import { failureText, keyed, reaComponentStates } from "./rea-state.js";
import { run as defaultRun } from "./tool-run.js";

const messages = serverMessages.rea;
const tool = "rea";
const refuse = (message) => problem(message, 409);
const defaultDarwinMajor = () =>
  process.platform === "darwin" ? Number(os.release().split(".")[0]) : NaN;
const flag = (value, fallback) => (typeof value === "boolean" ? value : fallback);

/**
 * The managed REA tool (AGENTPIER-104): REA Core as a frozen npm package on its own
 * managed MCP row, the pinned Ghidra and JDK beside it, frida's prebuild inside Core
 * and REA's skill in the bound CLIs' profiles. One REA job runs at a time; what it
 * does lands in state().step and state().message. Removing or replacing files that a
 * running REA uses is refused while `inUse()` (assigned by the wiring) says so.
 */
export class ReaTool {
  constructor({
    dataDir,
    servers,
    changes,
    packages,
    extensions,
    audit = null,
    manifest = reaManifest,
    core = reaCore(),
    platform = process.platform,
    arch = process.arch,
    darwinMajor = defaultDarwinMajor(),
    fetchImpl = fetch,
    run = defaultRun,
    env = cleanEnvironment(),
  }) {
    Object.assign(this, {
      dataDir,
      servers,
      changes,
      packages,
      extensions,
      audit,
      manifest,
      core,
      platform,
      arch,
      darwinMajor,
      fetchImpl,
      run,
      env,
    });
    this.root = path.join(dataDir, "clis");
    this.directory = path.join(dataDir, "rea");
    this.file = path.join(this.directory, "settings.json");
    this.inUse = async () => false;
    this.job = null;
    this.controller = null;
    // Set while a refusal check awaits inUse(): no second job may start meanwhile.
    this.claimed = false;
    this.status = "idle";
    this.step = null;
    this.message = "";
    // The Frida choice of the running job, which afterInstall follows.
    this.wanted = null;
  }
  host() {
    const { platform, arch, darwinMajor } = this;
    return reaPlatform({ platform, arch, darwinMajor }, this.manifest);
  }
  serverId() {
    return this.servers.managed?.byTool(tool) ?? null;
  }
  /** The stored choice: components, bring-your-own settings and a pending request. */
  stored() {
    let saved = null;
    try {
      saved = readJSON(this.file, null);
    } catch (error) {
      logFailure("read REA's settings", error);
    }
    const source = record(saved) ? saved : {};
    let settings;
    try {
      settings = cleanReaSettings(source.settings);
    } catch {
      settings = cleanReaSettings({});
    }
    return {
      components: {
        ghidra: source.components?.ghidra === true,
        frida: source.components?.frida === true,
      },
      settings,
      requested: record(source.requested) ? source.requested : null,
    };
  }
  save(components, settings) {
    writePrivate(this.file, { serverId: this.serverId(), components, settings });
  }
  record(id = this.serverId()) {
    const row = id ? this.packages.records.get(id) : null;
    return row &&
      row.registry === this.core.ref.registry &&
      row.name === this.core.ref.name
      ? row
      : null;
  }
  installed() {
    const row = this.record();
    return !!row && this.packages.records.computedStatus(row) === "ready";
  }
  /** The digest of the committed lock, or null when it cannot be checked. */
  lockDigest() {
    if (this.digest === undefined)
      try {
        this.digest = frozenPreview(this.packages, this.core).digest;
      } catch (error) {
        logFailure("check REA's committed lock", error);
        this.digest = null;
      }
    return this.digest;
  }
  component(id) {
    return managedReaComponent(this.root, id);
  }
  /** Whether Core's record differs from the pinned version or the committed lock. */
  coreOutdated(row) {
    const digest = this.lockDigest();
    return (
      !!row &&
      (row.version !== this.core.ref.version ||
        (digest !== null && row.lockDigest !== digest))
    );
  }
  /** Which installed parts differ from the pins of this AgentPier: Core, Ghidra/JDK. */
  outdatedParts() {
    const ghidra = this.component("rea-ghidra");
    const jdk = this.component("rea-jdk");
    return {
      core: this.coreOutdated(this.record()),
      ghidra:
        this.stored().components.ghidra &&
        !!this.host().ghidra &&
        (ghidra?.version !== this.manifest.ghidra.version ||
          jdk?.version !== this.manifest.jdk.version),
    };
  }
  /** Whether an installed part differs from the pins of this AgentPier. */
  outdated() {
    const parts = this.outdatedParts();
    return parts.core || parts.ghidra;
  }
  state() {
    const host = this.host();
    const id = this.serverId();
    const row = this.record(id);
    const installed = this.installed();
    const stored = this.stored();
    const ghidra = this.component("rea-ghidra");
    const jdk = this.component("rea-jdk");
    const message = host.available ? this.message : "";
    const server = id ? this.servers.get(id) : null;
    const outdated = installed ? this.outdatedParts() : { core: false, ghidra: false };
    const parts = reaComponentStates({
      host,
      manifest: this.manifest,
      ghidra,
      jdk,
      frida: installed && stored.components.frida,
    });
    return {
      available: host.available,
      reason: host.reason,
      ...keyed("reason", host.reason),
      status: this.job ? "running" : this.status,
      step: this.job ? this.step : null,
      message,
      ...keyed("message", message),
      installed,
      serverId: id,
      serverName: server?.name ?? null,
      updateAvailable: outdated.core || outdated.ghidra,
      components: {
        core: {
          installed,
          version: row?.version ?? null,
          pinnedVersion: this.core.ref.version,
          packageStatus: row ? this.packages.records.computedStatus(row) : null,
          downloadSize: this.manifest.core.downloadSize,
          installedSize: this.manifest.core.installedSize,
          outdated: outdated.core,
        },
        ghidra: { ...parts.ghidra, outdated: outdated.ghidra },
        frida: parts.frida,
      },
      settings: stored.settings,
    };
  }
  /**
   * The REA row of the Work tab's utilities. A fault (an unreadable store or settings)
   * degrades this row only, never the whole workspace state.
   */
  utility() {
    const row = {
      id: tool,
      name: "REA",
      utility: true,
      installed: false,
      version: null,
      pinnedVersion: this.core.ref.version,
      updateAvailable: false,
      status: this.job ? "running" : this.status,
    };
    try {
      const installed = this.installed();
      return {
        ...row,
        installed,
        version: this.record()?.version ?? null,
        updateAvailable: installed && this.outdated(),
      };
    } catch (error) {
      logFailure("read REA's state", error);
      return { ...row, status: "failed" };
    }
  }
  requireIdle() {
    if (this.job || this.claimed) throw refuse(messages.busy);
  }
  /** Refuses (409) while REA runs somewhere; holds the job slot while it asks. */
  async requireUnused(when) {
    if (!when) return;
    this.claimed = true;
    try {
      if (await this.inUse()) throw refuse(messages.inUse);
    } finally {
      this.claimed = false;
    }
    this.requireIdle();
  }
  /** The components wanted, refused (409) where this host has none. */
  wantedComponents(input, host, stored) {
    const wanted = record(input) ? input : {};
    const components = {
      ghidra: flag(wanted.ghidra, stored.components.ghidra),
      frida: flag(wanted.frida, stored.components.frida),
    };
    if (components.ghidra && !host.ghidra) throw refuse(host.ghidraReason);
    if (components.frida && !host.frida) throw refuse(host.fridaReason);
    return components;
  }
  /**
   * Installs REA or changes its components and settings. Starts a job and returns the
   * state at once; the first install needs `confirmInstall: true`.
   */
  async apply(input, { source = "user" } = {}) {
    const host = this.host();
    if (!host.available) throw refuse(host.reason);
    const body = record(input) ? input : {};
    const stored = this.stored();
    const components = this.wantedComponents(body.components, host, stored);
    const settings =
      body.settings === undefined ? stored.settings : cleanReaSettings(body.settings);
    this.requireIdle();
    const id = this.serverId();
    if (!id && body.confirmInstall !== true) throw refuse(messages.confirmationRequired);
    const ghidraGoes =
      !components.ghidra &&
      (!!this.component("rea-ghidra") || !!this.component("rea-jdk"));
    await this.requireUnused(
      !!id && (ghidraGoes || components.frida !== stored.components.frida),
    );
    this.begin((signal) =>
      this.converge({ components, settings, update: false, source, stored }, signal),
    );
    return this.state();
  }
  /** Brings an installed REA to this AgentPier's pins (a job; refused while in use). */
  async update({ source = "user" } = {}) {
    const host = this.host();
    if (!host.available) throw refuse(host.reason);
    this.requireIdle();
    if (!this.serverId()) throw refuse(messages.notInstalled);
    await this.requireUnused(true);
    const stored = this.stored();
    const components = {
      ghidra: stored.components.ghidra && !!host.ghidra,
      frida: stored.components.frida && !!host.frida,
    };
    this.begin((signal) =>
      this.converge(
        { components, settings: stored.settings, update: true, source, stored },
        signal,
      ),
    );
    return this.state();
  }
  begin(work) {
    const controller = new AbortController();
    this.controller = controller;
    this.status = "running";
    this.step = null;
    this.message = "";
    this.aborted = false;
    this.job = (async () => {
      await null;
      try {
        await work(controller.signal);
        this.status = "succeeded";
        this.message = "";
      } catch (error) {
        this.status = "failed";
        this.message = failureText(error);
        // Stopped by close(): no verdict on the install, so a request stays for later.
        this.aborted = controller.signal.aborted;
        logFailure("install or change REA", error);
      } finally {
        this.job = null;
        this.controller = null;
        this.step = null;
        this.wanted = null;
      }
    })();
  }
  /** Resolves once the running job ended; never rejects. */
  settled() {
    return Promise.resolve(this.job);
  }
  progress(step, message = "") {
    this.step = step;
    this.message = message;
  }
  async converge({ components, settings, update, source, stored }, signal) {
    this.wanted = components;
    prepareReaHome(this.dataDir);
    await this.placeComponents(components, update, signal);
    const id = await this.placeCore({ components, settings, stored, update, source });
    this.progress("environment", messages.configuring);
    await this.applyEnvironment(id, settings);
    this.save(components, settings);
    this.progress("skills", messages.copyingSkill);
    await syncReaSkills(this.skillContext(id));
  }
  async placeComponents(components, update, signal) {
    const host = this.host();
    if (!components.ghidra) {
      if (!this.component("rea-ghidra") && !this.component("rea-jdk")) return;
      this.progress("ghidra", messages.removing("Ghidra"));
      await removeReaComponent(this.root, "rea-ghidra");
      await removeReaComponent(this.root, "rea-jdk");
      return;
    }
    const parts = [
      ["rea-jdk", "jdk", host.ghidra.jdk, this.manifest.jdk.version],
      ["rea-ghidra", "ghidra", host.ghidra.entry, this.manifest.ghidra.version],
    ];
    for (const [id, step, entry, version] of parts) {
      const current = this.component(id);
      if (current && (!update || current.version === version)) continue;
      this.progress(step);
      await installReaComponent({
        root: this.root,
        id,
        version,
        entry,
        fetchImpl: this.fetchImpl,
        signal,
        run: this.run,
        env: this.env,
        platform: this.platform,
        progress: (message) => (this.message = message),
      });
    }
  }
  /** A free name for the new row: `rea`, else `rea-agentpier`, else `rea-agentpier-<n>`. */
  rowName() {
    const taken = new Set(this.servers.list().map((server) => server.name.toLowerCase()));
    let name = taken.has(tool) ? "rea-agentpier" : tool;
    for (let n = 2; taken.has(name); n += 1) name = `rea-agentpier-${n}`;
    return name;
  }
  async placeCore({ components, settings, stored, update, source }) {
    let id = this.serverId();
    const { program, args } = this.core;
    this.progress("core", messages.installingCore);
    if (!id) {
      const server = await createFrozenServer(
        this.packages,
        {
          name: this.rowName(),
          transport: "stdio",
          args: [...args],
          env: reaEnvironment({
            home: prepareReaHome(this.dataDir),
            ghidra: this.component("rea-ghidra"),
            jdk: this.component("rea-jdk"),
            settings,
          }),
        },
        {
          clis: ["claude"],
          frozen: this.core,
          program,
          managed: { tool, lockedEnv: [...reaManagedKeys] },
        },
      );
      id = server.id;
      this.auditRow("mcp.created", id, source);
    } else {
      const row = this.record(id);
      // A managed row without REA's package (a restored backup): the card removes it.
      if (!row) throw refuse(messages.rowBroken);
      let kind = null;
      if (
        this.packages.records.computedStatus(row) !== "ready" ||
        components.frida !== stored.components.frida
      )
        kind = "reinstall";
      else if (update && this.coreOutdated(row)) kind = "update";
      if (kind) installFrozen(this.packages, id, this.core, program, kind);
    }
    await jobSettled(this.packages, id);
    if (this.packages.jobs.get(id)?.state === "failed")
      throw problem(this.packages.status(id).error?.message ?? messages.coreFailed, 502);
    return id;
  }
  async applyEnvironment(id, settings) {
    const wanted = reaEnvironment({
      home: prepareReaHome(this.dataDir),
      ghidra: this.component("rea-ghidra"),
      jdk: this.component("rea-jdk"),
      settings,
    });
    const patch = reaEnvPatch(this.servers.envValues(id), wanted);
    if (Object.keys(patch).length)
      await this.changes.update(
        id,
        { revision: this.servers.get(id).revision, env: patch },
        { confirmStdio: true },
      );
    // Every name REA may set stays REA's, set or not: the owner keeps all others.
    this.servers.managed.setLockedEnv(id, [...reaManagedKeys]);
  }
  /**
   * Points an idle, installed REA's row env at the current component homes (an
   * installer run switched the links). Applied while in use too, like a settings
   * change: a running REA keeps its environment and the previous version folder,
   * which the next install prunes; sessions started afterwards get the new homes.
   */
  async syncEnvironment() {
    const id = this.serverId();
    if (!id || this.job || this.claimed || !this.installed()) return;
    await this.applyEnvironment(id, this.stored().settings);
  }
  skillContext(serverId) {
    return {
      serverId,
      servers: this.servers,
      packageSkills: this.packages.skills,
      extensions: this.extensions,
    };
  }
  auditRow(action, id, source) {
    try {
      this.audit?.append({
        action,
        resourceType: "mcp",
        resourceId: id,
        outcome: "success",
        source,
        details: { transport: "stdio", origin: "managed" },
      });
    } catch (error) {
      logFailure(`audit ${action}`, error);
    }
  }
  /** Removes REA, whatever is left of it (rea-lifecycle.js). */
  uninstall(options) {
    return uninstallRea(this, options);
  }
  /** The server-start sweep, requested install and update (rea-lifecycle.js). */
  start() {
    return startRea(this);
  }
  /** The row's CLI bindings changed: the skill copies follow. Never throws. */
  async bindingsChanged() {
    try {
      const id = this.serverId();
      if (!id || this.job || !this.installed()) return;
      await syncReaSkills(this.skillContext(id));
    } catch (error) {
      logFailure("update REA's skill copies", error);
    }
  }
  /**
   * McpPackages' hook before an install is committed: places frida's prebuild in the
   * managed REA row's Core only (never another server, whatever package it installs).
   */
  async afterInstall(serverId, context) {
    if (!serverId || serverId !== this.serverId()) return;
    const entry = this.host().frida;
    const wanted = this.wanted ? this.wanted.frida : this.stored().components.frida;
    if (!wanted || !entry) return;
    await placeFridaPrebuild({ ...context, entry, fetchImpl: this.fetchImpl });
  }
  /** AgentPier stops: a running download or unpack ends. */
  async close() {
    this.controller?.abort();
    await this.settled();
  }
}
