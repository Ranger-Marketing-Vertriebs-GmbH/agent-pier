import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { cleanEnvironment } from "../accounts/account-store.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
import { craftManifest, craftPlatform } from "./craft-manifest.js";
import {
  craftHome,
  craftManagedKeys,
  ensureGhidraStub,
  sessionsConfigDir,
  writeCraftConfig,
} from "./craft-config.js";
import { craftRowPatch, cleanCraftSettings } from "./craft-row.js";
import { syncCraftSkills } from "./craft-skills.js";
import { startCraft, uninstallCraft } from "./craft-lifecycle.js";
import { reaManifest as defaultReaManifest, reaPlatform } from "./rea-manifest.js";
import {
  installReaComponent,
  managedReaComponent,
  placeGhidra,
  reaComponentIds,
  removeReaComponent,
} from "./rea-components.js";
import {
  VersionSweep,
  clearRemovedMark,
  craftServersHoldGhidra,
  removeToolFolder,
  wantsGhidraOf,
} from "./version-sweep.js";
import { craftProxies, craftSessionRow, followProxies } from "./craft-proxy.js";
import { runningCommandLines } from "../../lib/process-commands.js";
import { failureText, keyed, queueSync, reaComponentStates } from "./rea-state.js";
import { run as defaultRun } from "./tool-run.js";

const messages = serverMessages.craft;
const tool = "craft-anything";
const refuse = (message) => problem(message, 409);
const defaultDarwinMajor = () =>
  process.platform === "darwin" ? Number(os.release().split(".")[0]) : NaN;

/**
 * The managed Craft Anything tool: the pinned CLI below `<dataDir>/clis`, its own
 * managed stdio MCP row bound to Claude Code (always `--restricted`), its config
 * pinned to AgentPier's keys and, when wanted, the Ghidra and JDK it shares with REA.
 * One job runs at a time, as with ReaTool. Hooks the wiring assigns: `inUse` (a
 * rebuild runs, or a call of its Craft Anything is in flight; a session's idle MCP
 * server never counts), `onChange` (state changed), `keepsGhidra` (the other tool
 * wants Ghidra, so it is never removed here), `othersUseGhidra` (the other tool's job
 * runs Ghidra, so it is neither removed nor replaced) and `othersBusy` (the other
 * tool's job runs, so no job starts here). An update installs beside the old version;
 * a folder a running process still uses stays until it exits (VersionSweep).
 */
export class CraftTool {
  constructor({
    dataDir,
    servers,
    changes,
    packages,
    extensions,
    audit = null,
    manifest = craftManifest,
    reaManifest = defaultReaManifest,
    platform = process.platform,
    arch = process.arch,
    darwinMajor = defaultDarwinMajor(),
    fetchImpl = fetch,
    run = defaultRun,
    env = cleanEnvironment(),
    commandLines = runningCommandLines,
    node = process.execPath,
  }) {
    Object.assign(this, {
      dataDir,
      servers,
      changes,
      packages,
      extensions,
      audit,
      manifest,
      reaManifest,
      platform,
      arch,
      darwinMajor,
      fetchImpl,
      run,
      env,
      node,
    });
    this.unwatch = null;
    this.root = path.join(dataDir, "clis");
    this.directory = craftHome(dataDir);
    this.file = path.join(this.directory, "settings.json");
    this.inUse = async () => false;
    this.onChange = null;
    this.keepsGhidra = () => false;
    this.othersUseGhidra = async () => false;
    this.othersBusy = () => false;
    this.jobCount = 0;
    this.job = null;
    this.controller = null;
    this.claimed = false;
    this.syncing = null;
    this.status = "idle";
    this.step = null;
    this.message = "";
    this.versions = new VersionSweep({
      root: this.root,
      ids: reaComponentIds,
      commandLines,
      onChange: () => this.changed(),
      also: craftServersHoldGhidra(dataDir),
      busy: () => !!this.job || this.claimed || this.othersBusy(),
      leftovers: (held) => removeToolFolder(this, held),
    });
  }
  host() {
    const { platform, arch } = this;
    return craftPlatform({ platform, arch }, this.manifest);
  }
  /** REA's view of this host: where the shared Ghidra and JDK come from, or why not. */
  reaHost() {
    const { platform, arch, darwinMajor } = this;
    return reaPlatform({ platform, arch, darwinMajor }, this.reaManifest);
  }
  serverId() {
    return this.servers.managed?.byTool(tool) ?? null;
  }
  component(id) {
    return managedReaComponent(this.root, id);
  }
  /** The stored choice: Ghidra, the mode and a pending request of the installer. */
  stored() {
    let saved = null;
    try {
      saved = readJSON(this.file, null);
    } catch (error) {
      logFailure("read Craft Anything's settings", error);
    }
    const source = record(saved) ? saved : {};
    let settings;
    try {
      settings = cleanCraftSettings(source.settings);
    } catch {
      settings = cleanCraftSettings({});
    }
    return {
      components: { ghidra: source.components?.ghidra === true },
      settings,
      requested: record(source.requested) ? source.requested : null,
    };
  }
  save(components, settings) {
    writePrivate(this.file, { serverId: this.serverId(), components, settings });
    clearRemovedMark(this);
    this.changed();
  }
  /** Whether the owner chose Ghidra for Craft Anything (the other tool keeps it then). */
  wantsGhidra() {
    return wantsGhidraOf(this);
  }
  /** Calls `onChange()` after a change of state(); never throws. */
  changed() {
    try {
      this.onChange?.();
    } catch (error) {
      logFailure("announce Craft Anything's state", error);
    }
  }
  installed() {
    return !!this.serverId() && !!this.component(tool);
  }
  /** Which installed parts differ from this AgentPier's pins: the CLI, Ghidra/JDK. */
  outdatedParts() {
    const ghidra = this.component("rea-ghidra");
    const jdk = this.component("rea-jdk");
    return {
      core: this.component(tool)?.version !== this.manifest.version,
      ghidra:
        this.stored().components.ghidra &&
        !!this.reaHost().ghidra &&
        (ghidra?.version !== this.reaManifest.ghidra.version ||
          jdk?.version !== this.reaManifest.jdk.version),
    };
  }
  outdated() {
    const parts = this.outdatedParts();
    return parts.core || parts.ghidra;
  }
  state() {
    const host = this.host();
    const id = this.serverId();
    const installed = this.installed();
    const stored = this.stored();
    const ghidra = this.component("rea-ghidra");
    const jdk = this.component("rea-jdk");
    const message = host.available ? this.message : "";
    const server = id ? this.servers.get(id) : null;
    const outdated = installed ? this.outdatedParts() : { core: false, ghidra: false };
    const parts = reaComponentStates({
      host: this.reaHost(),
      manifest: this.reaManifest,
      ghidra,
      jdk,
      frida: false,
      wanted: stored.components.ghidra,
    });
    return {
      available: host.available,
      reason: host.reason,
      ...keyed("reason", host.reason),
      status: this.job ? "running" : this.status,
      jobCount: this.jobCount,
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
          version: this.component(tool)?.version ?? null,
          pinnedVersion: this.manifest.version,
          downloadSize: host.entry?.size ?? null,
          installedSize: host.entry?.installedSize ?? null,
          outdated: outdated.core,
          // Older versions sessions' idle MCP servers still run until they reload.
          runningVersions: this.versions
            .runningVersions(tool)
            .filter((version) => version !== this.component(tool)?.version),
          // A session's proxy could not switch to the installed version.
          swapFailed: installed && craftProxies(this.dataDir).some((p) => p.error),
        },
        ghidra: {
          ...parts.ghidra,
          outdated: outdated.ghidra,
          shared: parts.ghidra.installed && this.keepsGhidra(),
        },
      },
      settings: stored.settings,
    };
  }
  /** Craft Anything's row of the Work tab's utilities; a fault degrades this row only. */
  utility() {
    const row = {
      id: tool,
      name: "Craft Anything",
      utility: true,
      installed: false,
      version: null,
      pinnedVersion: this.manifest.version,
      updateAvailable: false,
      status: this.job ? "running" : this.status,
    };
    try {
      const installed = this.installed();
      return {
        ...row,
        installed,
        version: this.component(tool)?.version ?? null,
        updateAvailable: installed && this.outdated(),
      };
    } catch (error) {
      logFailure("read Craft Anything's state", error);
      return { ...row, status: "failed" };
    }
  }
  requireIdle() {
    if (this.job || this.claimed || this.othersBusy()) throw refuse(messages.busy);
  }
  /**
   * Refuses (409) while a rebuild or a call of its Craft Anything runs; holds the job
   * slot meanwhile. A session's idle MCP server keeps its version and never refuses.
   */
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
  /** Whether Ghidra and the JDK would go: not wanted, present and nobody keeps them. */
  ghidraGoes(components) {
    return (
      !components.ghidra &&
      !this.keepsGhidra() &&
      (!!this.component("rea-ghidra") || !!this.component("rea-jdk"))
    );
  }
  /**
   * Installs Craft Anything or changes Ghidra and the mode. Starts a job and returns
   * the state at once; the first install needs `confirmInstall: true`.
   */
  async apply(input, { source = "user" } = {}) {
    const host = this.host();
    if (!host.available) throw refuse(host.reason);
    const body = record(input) ? input : {};
    const stored = this.stored();
    const wanted = record(body.components) ? body.components : {};
    const components = {
      ghidra:
        typeof wanted.ghidra === "boolean" ? wanted.ghidra : stored.components.ghidra,
    };
    if (components.ghidra) {
      const rea = this.reaHost();
      if (!rea.ghidra) throw refuse(rea.ghidraReason ?? rea.reason);
    }
    const settings =
      body.settings === undefined ? stored.settings : cleanCraftSettings(body.settings);
    this.requireIdle();
    const id = this.serverId();
    if (!id && body.confirmInstall !== true) throw refuse(messages.confirmationRequired);
    await this.requireUnused(!!id && this.ghidraGoes(components));
    this.begin((signal) =>
      this.converge({ components, settings, update: false, source }, signal),
    );
    return this.state();
  }
  /** Brings an installed Craft Anything to the pins (a job; refused while in use). */
  async update({ source = "user" } = {}) {
    const host = this.host();
    if (!host.available) throw refuse(host.reason);
    this.requireIdle();
    if (!this.serverId()) throw refuse(messages.notInstalled);
    await this.requireUnused(true);
    const stored = this.stored();
    const components = { ghidra: stored.components.ghidra && !!this.reaHost().ghidra };
    this.begin((signal) =>
      this.converge(
        { components, settings: stored.settings, update: true, source },
        signal,
      ),
    );
    return this.state();
  }
  begin(work) {
    const controller = new AbortController();
    this.controller = controller;
    this.jobCount += 1;
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
        this.message = failureText(error, messages.failed);
        // Stopped by close(): no verdict on the install, so a request stays for later.
        this.aborted = controller.signal.aborted;
        logFailure("install or change Craft Anything", error);
      } finally {
        this.job = null;
        this.controller = null;
        this.step = null;
        this.changed();
        void this.versions.run();
        this.watchProxies();
      }
    })();
    this.changed();
  }
  /** Resolves once the running job ended; never rejects. */
  settled() {
    return Promise.resolve(this.job);
  }
  progress(step, message = "") {
    this.step = step;
    this.message = message;
    this.changed();
  }
  async converge({ components, settings, update, source }, signal) {
    await this.syncing;
    ensureGhidraStub(this.dataDir);
    await this.placeGhidraParts(components, update, signal);
    await this.placeBinary(update, signal);
    const id = await this.placeRow(settings, source);
    this.progress("environment", messages.configuring);
    this.writeConfig(components);
    this.save(components, settings);
    this.progress("skills", messages.copyingSkill);
    await this.syncSkills(id);
  }
  /** Places or removes the shared Ghidra and JDK; never removes what the other keeps. */
  async placeGhidraParts(components, update, signal) {
    const held = this.versions.held();
    if (!components.ghidra) {
      if (!this.ghidraGoes(components) || (await this.othersUseGhidra())) return;
      this.progress("ghidra", messages.removing("Ghidra"));
      await removeReaComponent(this.root, "rea-ghidra", { held });
      await removeReaComponent(this.root, "rea-jdk", { held });
      return;
    }
    await placeGhidra({
      root: this.root,
      manifest: this.reaManifest,
      host: this.reaHost(),
      update,
      // REA's session runs the installed version: no replacing it now.
      keep: update && (await this.othersUseGhidra()),
      signal,
      fetchImpl: this.fetchImpl,
      run: this.run,
      env: this.env,
      platform: this.platform,
      progress: (step, message) => this.progress(step, message),
      held,
    });
  }
  /** Installs the pinned CLI when missing, or when an update finds another version. */
  async placeBinary(update, signal) {
    const current = this.component(tool);
    if (current && (!update || current.version === this.manifest.version)) return;
    this.progress("core", messages.installing);
    await installReaComponent({
      root: this.root,
      id: tool,
      version: this.manifest.version,
      entry: this.host().entry,
      fetchImpl: this.fetchImpl,
      signal,
      run: this.run,
      env: this.env,
      platform: this.platform,
      progress: (message) => this.progress("core", message),
      held: this.versions.held(),
    });
  }
  /**
   * What the row runs: AgentPier's swap proxy with the owner's mode. Writes the
   * proxies' spec, so running proxies swap to a new version (craft-proxy.js).
   */
  wantedRow(settings) {
    const component = this.component(tool);
    if (!component) throw refuse(messages.notInstalled);
    return craftSessionRow(this, component, settings);
  }
  /** Follows the proxies' status files: a swap ended, a session left or failed. */
  watchProxies() {
    followProxies(this);
  }
  /** A free name: `craft-anything`, else `craft-anything-agentpier[-<n>]`. */
  rowName() {
    const taken = new Set(this.servers.list().map((server) => server.name.toLowerCase()));
    let name = taken.has(tool) ? `${tool}-agentpier` : tool;
    for (let n = 2; taken.has(name); n += 1) name = `${tool}-agentpier-${n}`;
    return name;
  }
  async placeRow(settings, source) {
    const id = this.serverId();
    if (id) {
      await this.patchRow(id, settings);
      return id;
    }
    const server = await this.changes.create(
      { name: this.rowName(), transport: "stdio", ...this.wantedRow(settings) },
      {
        confirmStdio: true,
        clis: ["claude"],
        managed: { tool, lockedEnv: [...craftManagedKeys] },
      },
    );
    this.auditRow("mcp.created", server.id, source);
    return server.id;
  }
  /**
   * Points row `id` at the installed CLI, the owner's mode and AgentPier's env. The
   * tool itself may change its locked fields (only owner patches are refused).
   */
  async patchRow(id, settings) {
    const server = this.servers.get(id);
    if (server.transport !== "stdio") throw refuse(messages.rowBroken);
    const patch = craftRowPatch(
      server,
      this.servers.envValues(id),
      this.wantedRow(settings),
    );
    if (Object.keys(patch).length)
      await this.changes.update(
        id,
        { revision: server.revision, ...patch },
        { confirmStdio: true },
      );
    this.servers.managed.setLockedEnv(id, [...craftManagedKeys]);
  }
  /**
   * Rewrites AgentPier's keys in config.toml (the sessions' by default, or
   * `configDir`): the shared Ghidra when Craft Anything wants it (`components`, the
   * stored choice by default), else the stub.
   */
  writeConfig(
    components = this.stored().components,
    configDir = sessionsConfigDir(this.dataDir),
    { builder = false } = {},
  ) {
    const stub = ensureGhidraStub(this.dataDir);
    const ghidra = components.ghidra ? this.component("rea-ghidra") : null;
    const jdk = components.ghidra ? this.component("rea-jdk") : null;
    const both = !!ghidra && !!jdk;
    writeCraftConfig(configDir, {
      ghidra: both ? ghidra : null,
      jdk: both ? jdk : null,
      stub,
      builder,
    });
  }
  /**
   * Brings an idle, installed Craft Anything's row (command, args, env) and config in
   * line with the installed files and the stored mode, also while in use: sessions
   * started afterwards get the new state.
   */
  syncEnvironment() {
    return queueSync(this, async () => {
      const id = this.serverId();
      if (!id || this.job || this.claimed || !this.installed()) return;
      this.writeConfig();
      await this.patchRow(id, this.stored().settings);
    });
  }
  /**
   * The skill copies in the CLIs bound to row `serverId` (null: none, the copies go).
   */
  async syncSkills(serverId) {
    await syncCraftSkills({
      serverId,
      servers: this.servers,
      extensions: this.extensions,
    });
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
  /** Removes Craft Anything, whatever is left of it (craft-lifecycle.js). */
  uninstall(options) {
    return uninstallCraft(this, options);
  }
  /** The server-start sweep, requested install, update and rewrite (craft-lifecycle.js). */
  async start() {
    await startCraft(this);
    await this.versions.run();
    this.watchProxies();
  }
  /** The row's CLI bindings changed: the skill copies follow. Never throws. */
  async bindingsChanged() {
    try {
      const id = this.serverId();
      if (!id || this.job || !this.installed()) return;
      await this.syncSkills(id);
    } catch (error) {
      logFailure("update Craft Anything's skill copies", error);
    }
  }
  /** AgentPier stops: a running download or unpack ends. */
  async close() {
    this.controller?.abort();
    await this.settled();
    this.unwatch?.();
    await this.versions.close();
  }
}
