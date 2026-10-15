import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { messageIdentity } from "../../lib/i18n/message-identity.js";
import { record } from "../extensions/mcp-config.js";
import { privateFolder } from "./verified-files.js";
import { ensureToolchain, pruneToolchains } from "./toolchains.js";
import { PackageJobs } from "./install-jobs.js";
import { lockDiff } from "./lock-check.js";
import { npmAdapter } from "./npm-adapter.js";
import { packageError, packageProblem } from "./package-errors.js";
import { packageConstraints, packageName, packageRef } from "./package-spec.js";
import { packageRoot, pruneInstalls, readInstall } from "./package-store.js";
import { logFailure, runInstall, sourceFields } from "./package-install-job.js";
import { chooseProgram } from "./program-select.js";
import { pypiIndexRegistry, pythonAdapter } from "./python-adapter.js";
import { npmRegistry } from "./registry-metadata.js";
import { toolchainEntry } from "./toolchain-entry.js";

const previewLimit = 20;
const invalid = () => packageProblem("MCP_PACKAGE_INVALID", 400);
// A program name as program-select.js accepts one from npm or a wheel.
const programName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
/** The program the owner named before the install can say which ones exist. */
function laterProgram(wanted) {
  if (wanted === undefined || wanted === "") return { name: "", path: "" };
  if (typeof wanted !== "string" || !programName.test(wanted)) throw invalid();
  return { name: wanted, path: "" };
}

/** Previews, installs, updates and removes packaged MCP servers (docs/mcp.md). */
export class McpPackages {
  constructor({
    dataDir,
    servers,
    changes,
    registry = npmRegistry,
    download,
    toolchain = (kind) => ensureToolchain(kind, { dataDir }),
    execute,
    environment,
    now = Date.now,
    previewTtl = 15 * 60 * 1000,
    pypi = pypiIndexRegistry,
    adapters = { npm: npmAdapter, pypi: pythonAdapter },
    previewConcurrency = 2,
  }) {
    Object.assign(this, {
      dataDir,
      servers,
      changes,
      // Lock entries must start with `${registry}/`: one canonical spelling.
      registry: String(registry).replace(/\/+$/, ""),
      download,
      toolchain,
      execute,
      environment,
      now,
      previewTtl,
    });
    this.adapters = adapters;
    this.previewConcurrency = previewConcurrency;
    // Registry name → index URL its adapter talks to.
    this.registries = { npm: this.registry, pypi };
    this.resolving = 0;
    this.records = servers.packages;
    this.jobs = new PackageJobs({ settled: () => this.prune() });
    this.previews = new Map();
    // serverId → leading args stored before a running switch (package-install-job.js, activate()).
    this.switching = new Map();
    // Servers whose detach is switching them to an own command right now.
    this.detaching = new Set();
  }
  adapterOf(registry) {
    const adapter = Object.hasOwn(this.adapters, registry)
      ? this.adapters[registry]
      : null;
    if (!adapter) throw invalid();
    return adapter;
  }
  cacheDir(registry) {
    return path.join(
      packageRoot(this.dataDir),
      registry === "pypi" ? ".uv-cache" : ".npm-cache",
    );
  }
  /** A stored or previewed lock, checked again by its registry's adapter. */
  checkStored({ registry, name, version, lock, integrity }) {
    const ref = packageRef({ registry, name, version });
    return this.adapterOf(registry).checkStored(
      { lockText: lock, ref, integrity },
      { registry: this.registries[registry] },
    );
  }
  async versions(input) {
    const name = packageName(input);
    return this.adapterOf(input.registry).versions(name, {
      registry: this.registries[input.registry],
      download: this.download,
    });
  }
  async preview(input) {
    const ref = packageRef(input);
    const current = input.serverId ? this.records.get(input.serverId) : null;
    // An update keeps the stored constraints unless the owner sends new ones (D4).
    const constraints = packageConstraints(
      input.constraints === undefined && current
        ? { constraints: current.constraints }
        : input,
      ref,
    );
    try {
      return await this.resolvePreview(ref, input, constraints, current);
    } catch (error) {
      throw packageError(error, "MCP_PACKAGE_INSTALL_FAILED", 502);
    }
  }
  async resolvePreview(ref, input, constraints, current) {
    const allowScripts = input.allowScripts === true;
    const adapter = this.adapterOf(ref.registry);
    // Each resolve runs npm or uv; more than a few at once only queue on the host.
    if (this.resolving >= this.previewConcurrency)
      throw packageProblem("MCP_PACKAGE_BUSY", 409, "previewBusy");
    this.resolving += 1;
    const previewId = randomUUID();
    // Previews resolve outside installs/, so pruning never races a running preview.
    const stage = path.join(packageRoot(this.dataDir), "previews", previewId);
    let resolved;
    try {
      resolved = await adapter.preview({
        ref,
        allowScripts,
        constraints,
        // A loader: metadata errors come before any toolchain install.
        toolchain: () => this.toolchain(adapter.toolchainKind),
        stage: privateFolder(stage),
        registry: this.registries[ref.registry],
        download: this.download,
        cacheDir: this.cacheDir(ref.registry),
        execute: this.execute,
        environment: this.environment,
      });
    } finally {
      this.resolving -= 1;
      fs.rmSync(stage, { recursive: true, force: true });
    }
    const diff =
      current && resolved.lockText
        ? lockDiff(this.checkStored(current).dependencies, resolved.dependencies)
        : null;
    this.previews.set(previewId, {
      ...resolved,
      ref,
      allowScripts,
      constraints,
      expires: this.now() + this.previewTtl,
    });
    while (this.previews.size > previewLimit)
      this.previews.delete(this.previews.keys().next().value);
    return {
      previewId,
      ...ref,
      integrity: resolved.integrity,
      // PyPI: the release file the install uses ({ filename, sha256 }); npm has none.
      installFile: resolved.installFile ?? null,
      dependencyCount: resolved.dependencies.length,
      dependencies: resolved.dependencies,
      programs: resolved.programs.map((p) => p.name),
      needsScripts: resolved.needsScripts,
      constraints,
      diff,
    };
  }
  /** The confirmed preview for `source`; expired, unknown or different → refused. */
  takePreview(previewId, source) {
    const preview = this.previews.get(previewId);
    this.previews.delete(previewId);
    const ref = packageRef(source);
    if (
      !preview ||
      preview.expires < this.now() ||
      preview.ref.registry !== ref.registry ||
      preview.ref.name !== ref.name ||
      preview.ref.version !== ref.version ||
      preview.allowScripts !== (source.allowScripts === true) ||
      // The lock was resolved under exactly these constraints (canonical form).
      JSON.stringify(preview.constraints) !==
        JSON.stringify(packageConstraints(source, ref))
    )
      throw packageProblem("MCP_PACKAGE_PREVIEW_EXPIRED", 409);
    return preview;
  }
  /**
   * The preview taken once, the scripts rule checked and its program chosen. Without
   * programs at preview time the install names them (adapter.programsAfterInstall).
   */
  confirmedPreview(previewId, source, wanted) {
    const preview = this.takePreview(previewId, source);
    // Before the program: a package that must be built names its programs only then.
    if (preview.needsScripts === true && !preview.allowScripts)
      throw packageProblem("MCP_PACKAGE_NEEDS_SCRIPTS", 400);
    const program = preview.programs.length
      ? chooseProgram(preview.programs, wanted)
      : laterProgram(wanted);
    return { preview, program };
  }
  /** The record of a confirmed package before its first install. */
  pendingRecord({ preview, program }) {
    return {
      ...sourceFields(preview, program),
      installId: null,
      leadingArgs: 0,
      toolchainDir: null,
      status: "installing",
      errorCode: null,
    };
  }
  isPackaged(id) {
    return !!this.records.get(id);
  }
  async createServer(input, { clis, previewId, program } = {}) {
    if (!record(input) || input.transport !== "stdio" || input.command !== undefined)
      throw invalid();
    const { source, ...definition } = input;
    if (!record(source)) throw invalid();
    const confirmed = this.confirmedPreview(previewId, source, program ?? source.program);
    // Written in the server's own transaction: the first reconciliation already sees
    // a package that is installing, not a stdio server without a command.
    const server = await this.changes.create(definition, {
      confirmStdio: true,
      pendingCommand: true,
      packageRecord: this.pendingRecord(confirmed),
      ...(clis === undefined ? {} : { clis }),
    });
    this.install(server.id, { ...confirmed, kind: "install" });
    return this.servers.get(server.id);
  }
  /**
   * Switches an own-command stdio server to a package (owner decision D1). The own
   * command stays stored until the install switches command and args together; until
   * then the compilers skip the server, as for a new package.
   */
  async attach(id, { source, previewId, program } = {}, beforeInstall) {
    const server = this.servers.get(id);
    if (server.transport !== "stdio" || this.isPackaged(id) || !record(source))
      throw invalid();
    this.requireIdle(id);
    const confirmed = this.confirmedPreview(previewId, source, program ?? source.program);
    await beforeInstall?.();
    // Another attach or a detach may have run while the owner's edits were saved.
    this.requireIdle(id);
    if (this.isPackaged(id)) throw packageProblem("MCP_PACKAGE_BUSY", 409);
    this.records.put(id, this.pendingRecord(confirmed));
    this.install(id, { ...confirmed, kind: "install" });
    return this.servers.get(id);
  }
  /** Installs `preview` (or the stored lock) and switches the server to it. */
  install(serverId, options) {
    return runInstall(this, serverId, options);
  }
  /** Refuses while a job runs for `id` or a detach is switching it away. */
  requireIdle(id) {
    if (this.jobs.get(id)?.state === "running" || this.detaching.has(id))
      throw packageProblem("MCP_PACKAGE_BUSY", 409);
  }
  /**
   * Generated args stored in front of the owner's; 0 before the first install. While
   * a switch runs, its count before the switch holds only until the switch commits
   * (the revision moves on); then the ready record's count applies.
   */
  storedLeading(id, row) {
    const switching = this.switching.get(id);
    if (switching && this.servers.get(id).revision === switching.revision)
      return switching.before;
    return row?.installId ? row.leadingArgs : 0;
  }
  /** The server's args without the generated ones in front: what the owner entered. */
  ownerArgs(id) {
    const args = this.servers.get(id)?.args || [];
    return args.slice(this.storedLeading(id, this.records.get(id)));
  }
  prepareUpdate(id, input) {
    const row = this.records.get(id);
    if (!row || !record(input)) return input;
    if (input.command !== undefined) throw invalid();
    if (input.args === undefined) return input;
    const leading = (this.servers.get(id).args || []).slice(
      0,
      this.storedLeading(id, row),
    );
    return { ...input, args: [...leading, ...input.args] };
  }
  /** `update` switches the server to an own command first; then the record goes. */
  async detach(id, update) {
    this.requireIdle(id);
    if (!this.isPackaged(id)) throw invalid();
    // No install may start (and switch back) while the own command is being saved.
    this.detaching.add(id);
    try {
      await update?.();
      if (this.isPackaged(id)) this.records.remove(id);
    } finally {
      this.detaching.delete(id);
    }
    // Not awaited: toolchain pruning can queue behind a running toolchain install.
    this.prune();
  }
  async updatePackage(
    id,
    { version, allowScripts, constraints, previewId, program } = {},
  ) {
    const row = this.records.get(id);
    if (!row) throw invalid();
    // Before the preview is taken: a busy server keeps it for a retry.
    this.requireIdle(id);
    const confirmed = this.confirmedPreview(
      previewId,
      {
        registry: row.registry,
        name: row.name,
        version,
        allowScripts,
        // Kept unless the owner edits them, as in the update preview.
        constraints: constraints === undefined ? row.constraints : constraints,
      },
      // A record installed without a program yet stores "".
      program ?? (row.program || undefined),
    );
    return { job: this.install(id, { ...confirmed, kind: "update" }) };
  }
  reinstall(id) {
    const row = this.records.get(id);
    if (!row) throw invalid();
    this.requireIdle(id);
    const ref = packageRef(row);
    const preview = {
      ref,
      allowScripts: row.allowScripts,
      // Frozen in the stored lock: a reinstall never resolves again.
      constraints: row.constraints,
      integrity: row.integrity,
      manifestText: this.adapterOf(ref.registry).manifestText(ref),
      lockText: row.lock,
      digest: row.lockDigest,
      // As the install it replaces; without its receipt the record says the same.
      needsScripts:
        readInstall(this.dataDir, row.installId, row.lockDigest)?.needsScripts ??
        row.needsScripts === true,
    };
    this.checkStored(row);
    return {
      job: this.install(id, {
        preview,
        program: { name: row.program, path: row.programPath },
        kind: "reinstall",
      }),
    };
  }
  status(id) {
    const source = this.servers.get(id).source ?? null;
    const job = this.jobs.get(id);
    const code = job?.state === "failed" ? job.code : (source?.errorCode ?? null);
    if (!code) return { source, job, error: null };
    // Stable code plus the server message and its key; the browser translates the key.
    const { message } = packageProblem(code);
    return { source, job, error: { code, message, ...messageIdentity(message) } };
  }
  start() {
    // A crash can leave preview resolutions behind; no preview survives a restart.
    try {
      // Built by hand: packageRoot() would create the folder only to remove it.
      fs.rmSync(path.join(this.dataDir, "mcp-packages", "previews"), {
        recursive: true,
        force: true,
      });
    } catch (error) {
      logFailure("remove leftover MCP package previews", error);
    }
    for (const row of this.records.all())
      if (row.status === "installing" && !this.jobs.get(row.serverId))
        this.records.update(row.serverId, {
          status: "failed",
          errorCode: "MCP_PACKAGE_INSTALL_FAILED",
        });
    // An install deleted while AgentPier was stopped (or a restore) is missing: the CLIs
    // drop its entry now instead of starting a deleted program until a reinstall.
    const missing = this.records
      .all()
      .some((row) => this.records.computedStatus(row) === "missing");
    const reconciled = missing
      ? Promise.resolve()
          .then(() => this.changes.onSaved())
          .catch((error) => logFailure("update the CLIs for a missing install", error))
      : undefined;
    return Promise.all([this.prune(), reconciled]);
  }
  /**
   * Removes installs and stages nothing references now, then (in the background, never
   * rejecting) the toolchains no record and no running job uses. Tests await it.
   */
  prune() {
    try {
      // A running job's install id keeps its `.stage-<id>` as well.
      pruneInstalls(
        this.dataDir,
        new Set([...this.records.installIds(), ...this.jobs.runningInstallIds()]),
      );
    } catch (error) {
      logFailure("prune MCP package installs", error);
    }
    const inUse = [
      ...this.records.all().map((row) => row.toolchainDir),
      ...this.jobs.runningToolchainDirs(),
    ]
      .map((dir) => toolchainEntry(this.dataDir, dir))
      .filter(Boolean);
    return pruneToolchains(this.dataDir, inUse).catch((error) =>
      logFailure(
        "prune MCP package toolchains",
        error,
        "MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE",
      ),
    );
  }
}
