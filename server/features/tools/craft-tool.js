import os from "node:os";
import path from "node:path";
import { serverMessages } from "../../lib/i18n/de.js";
import { problem, readJSON, writePrivate } from "../../lib/storage.js";
import { record } from "../extensions/mcp-config.js";
import { cleanEnvironment } from "../accounts/account-store.js";
import { logFailure } from "../mcp-packages/package-install-job.js";
import { craftManifest, craftPlatform } from "./craft-manifest.js";
import {
  craftEnvironment,
  craftHome,
  craftManagedKeys,
  ensureGhidraStub,
  sessionsConfigDir,
  writeCraftConfig,
} from "./craft-config.js";
import {
  craftArgs,
  craftCommand,
  craftRowPatch,
  cleanCraftSettings,
} from "./craft-row.js";
import { startCraft, uninstallCraft } from "./craft-lifecycle.js";
import { reaManifest as defaultReaManifest, reaPlatform } from "./rea-manifest.js";
import {
  installReaComponent,
  managedReaComponent,
  placeGhidra,
  removeReaComponent,
} from "./rea-components.js";
import { failureText, keyed, reaComponentStates } from "./rea-state.js";
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
 * session runs the row), `onChange` (state changed) and `keepsGhidra` (the other tool
 * wants Ghidra, so it is never removed here).
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
    });
    this.root = path.join(dataDir, "clis");
    this.directory = craftHome(dataDir);
    this.file = path.join(this.directory, "settings.json");
    this.inUse = async () => false;
    this.onChange = null;
    this.keepsGhidra = () => false;
    this.jobCount = 0;
    this.job = null;
    this.controller = null;
    this.claimed = false;
    this.status = "idle";
    this.step = null;
    this.message = "";
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
    this.changed();
  }
  /** Whether the owner chose Ghidra for Craft Anything (the other tool keeps it then). */
  wantsGhidra() {
    return this.stored().components.ghidra;
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
    if (this.job || this.claimed) throw refuse(messages.busy);
  }
  /** Refuses (409) while a session runs Craft Anything; holds the job slot meanwhile. */
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
    ensureGhidraStub(this.dataDir);
    await this.placeGhidraParts(components, update, signal);
    await this.placeBinary(update, signal);
    const id = await this.placeRow(settings, source);
    this.progress("environment", messages.configuring);
    this.writeConfig();
    this.save(components, settings);
    this.progress("skills", messages.copyingSkill);
    await this.syncSkills(id);
  }
  /** Places or removes the shared Ghidra and JDK; never removes what the other keeps. */
  async placeGhidraParts(components, update, signal) {
    if (!components.ghidra) {
      if (!this.ghidraGoes(components)) return;
      this.progress("ghidra", messages.removing("Ghidra"));
      await removeReaComponent(this.root, "rea-ghidra");
      await removeReaComponent(this.root, "rea-jdk");
      return;
    }
    await placeGhidra({
      root: this.root,
      manifest: this.reaManifest,
      host: this.reaHost(),
      update,
      signal,
      fetchImpl: this.fetchImpl,
      run: this.run,
      env: this.env,
      platform: this.platform,
      progress: (step, message) => this.progress(step, message),
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
    });
  }
  /** What the row runs: the installed CLI with the owner's mode and AgentPier's env. */
  wantedRow(settings) {
    const component = this.component(tool);
    if (!component) throw refuse(messages.notInstalled);
    return {
      command: craftCommand(this.root, component),
      args: craftArgs(settings),
      env: craftEnvironment(this.dataDir),
    };
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
  /** Rewrites AgentPier's keys in config.toml: the shared Ghidra, else the stub. */
  writeConfig() {
    const stub = ensureGhidraStub(this.dataDir);
    const ghidra = this.component("rea-ghidra");
    const jdk = this.component("rea-jdk");
    const both = !!ghidra && !!jdk;
    writeCraftConfig(sessionsConfigDir(this.dataDir), {
      ghidra: both ? ghidra : null,
      jdk: both ? jdk : null,
      stub,
    });
  }
  /**
   * Brings an idle, installed Craft Anything's row (command, args, env) and config in
   * line with the installed files and the stored mode, also while in use: sessions
   * started afterwards get the new state.
   */
  async syncEnvironment() {
    const id = this.serverId();
    if (!id || this.job || this.claimed || !this.installed()) return;
    this.writeConfig();
    await this.patchRow(id, this.stored().settings);
  }
  /**
   * The skill copies in the CLIs bound to row `serverId` (null: none, the copies go).
   * Kept a no-op here; the skill sync fills it in.
   */
  async syncSkills(_serverId) {}
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
  start() {
    return startCraft(this);
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
  }
}
