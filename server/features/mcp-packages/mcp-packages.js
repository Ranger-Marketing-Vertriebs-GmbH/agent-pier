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
import {
  installError,
  logFailure,
  runInstall,
  sourceFields,
  switchedTo,
} from "./package-install-job.js";
import { chooseInstalledProgram, choosablePrograms } from "./program-choice.js";
import { chooseProgram, programName } from "./program-select.js";
import { pypiIndexRegistry, pythonAdapter } from "./python-adapter.js";
import { npmRegistry } from "./registry-metadata.js";
import { toolchainEntry } from "./toolchain-entry.js";

const previewLimit = 20;
const invalid = () => packageProblem("MCP_PACKAGE_INVALID", 400);
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
    // AbortController of each running preview → its settling (never rejects).
    this.previewRuns = new Map();
    // serverId → leading args stored before a running switch (package-install-job.js, activate()).
    this.switching = new Map();
    // Servers whose detach is switching them to an own command right now.
    this.detaching = new Set();
    // createServer() calls between storing the installing record and starting its job.
    this.claiming = 0;
    this.records.orphaned = (id) =>
      this.claiming === 0 && this.jobs.get(id)?.state !== "running";
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
    // Tracked, so close() can stop its npm or uv process group at shutdown.
    const controller = new AbortController();
    try {
      const running = adapter.preview({
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
        signal: controller.signal,
      });
      const quiet = () => {};
      this.previewRuns.set(controller, running.then(quiet, quiet));
      resolved = await running;
    } finally {
      this.previewRuns.delete(controller);
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
  /** The confirmed preview for `source`, left in place; expired, unknown or different → refused. */
  peekPreview(previewId, source) {
    const preview = this.previews.get(previewId);
    const ref = packageRef(source);
    const expired = preview && preview.expires < this.now();
    if (expired) this.previews.delete(previewId);
    if (
      !preview ||
      expired ||
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
  /** Takes a checked preview once; a second use of the same id is refused. */
  consumePreview(previewId) {
    if (!this.previews.delete(previewId))
      throw packageProblem("MCP_PACKAGE_PREVIEW_EXPIRED", 409);
  }
  /**
   * The preview with the scripts rule checked and its program chosen; it stays until
   * the caller consumes it, so a refused choice can be retried. Without programs at
   * preview time the install names them (adapter.programsAfterInstall).
   */
  confirmedPreview(previewId, source, wanted) {
    const preview = this.peekPreview(previewId, source);
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
    let server;
    // Until its job runs, the new record is installing, not orphaned.
    this.claiming += 1;
    try {
      this.consumePreview(previewId);
      try {
        // Written in the server's own transaction: the first reconciliation already
        // sees a package that is installing, not a stdio server without a command.
        server = await this.changes.create(definition, {
          confirmStdio: true,
          pendingCommand: true,
          packageRecord: this.pendingRecord(confirmed),
          ...(clis === undefined ? {} : { clis }),
        });
      } catch (error) {
        // Nothing was stored (a taken name, a refused CLI): the owner may save again.
        this.previews.set(previewId, confirmed.preview);
        throw error;
      }
      this.install(server.id, { ...confirmed, kind: "install" });
    } finally {
      this.claiming -= 1;
    }
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
    // Taken only now: an attach that lost to a concurrent one keeps its preview.
    this.consumePreview(previewId);
    try {
      this.records.put(id, this.pendingRecord(confirmed));
    } catch (error) {
      this.previews.set(previewId, confirmed.preview);
      throw installError(error);
    }
    this.install(id, { ...confirmed, kind: "install" });
    return this.servers.get(id);
  }
  /** Installs `preview` (or the stored lock) and switches the server to it. */
  install(serverId, options) {
    return runInstall(this, serverId, options);
  }
  /** Stops the running install of `id` (its server was deleted); see PackageJobs#cancel. */
  cancel(id) {
    return this.jobs.cancel(id);
  }
  /**
   * AgentPier stops: running installs and previews end with their npm or uv process
   * groups (which run detached and would outlive it); the stages go. The groups get
   * SIGKILL after `graceMs`. Resolves once all settled, or after `waitMs`: a toolchain
   * download only notices the cancel once it ends. server/index.js exits forcibly 6 s
   * after a stop signal and shutdown.js starts this first, so `graceMs` plus the
   * settling stays well inside `waitMs`, and `waitMs` well inside those 6 s.
   */
  close({ waitMs = 3000, graceMs = 500 } = {}) {
    const reason = { graceMs };
    for (const controller of this.previewRuns.keys()) controller.abort(reason);
    const settled = Promise.all([
      this.jobs.cancelAll(reason),
      ...this.previewRuns.values(),
    ]);
    let timer;
    const bound = new Promise((resolve) => (timer = setTimeout(resolve, waitMs)));
    return Promise.race([settled, bound]).finally(() => clearTimeout(timer));
  }
  /** Refuses while a job runs for `id` or a detach is switching it away. */
  requireIdle(id) {
    if (this.jobs.get(id)?.state === "running" || this.detaching.has(id))
      throw packageProblem("MCP_PACKAGE_BUSY", 409);
  }
  /**
   * Generated args stored in front of the owner's; 0 before the first install. While
   * a switch runs, its old count holds until the stored command is the switch's own
   * (an owner edit racing it keeps the old command and the old count).
   */
  storedLeading(id, row) {
    const switching = this.switching.get(id);
    if (switching)
      return switchedTo(this.servers.get(id), switching)
        ? switching.after
        : switching.before;
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
      try {
        if (this.isPackaged(id)) this.records.remove(id);
      } catch (error) {
        throw installError(error);
      }
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
    this.consumePreview(previewId);
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
  /** Activates one program of a build that named several (status `choosing`). */
  chooseProgram(id, wanted) {
    return chooseInstalledProgram(this, id, wanted);
  }
  status(id) {
    const source = this.servers.get(id).source ?? null;
    const job = this.jobs.get(id);
    // The programs of a build waiting for the owner's choice; none otherwise.
    const programs = choosablePrograms(this, id);
    const code = job?.state === "failed" ? job.code : (source?.errorCode ?? null);
    if (!code) return { source, job, error: null, programs };
    // Stable code plus the server message and its key; the browser translates the key.
    const { message } = packageProblem(code);
    return {
      source,
      job,
      error: { code, message, ...messageIdentity(message) },
      programs,
    };
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
        try {
          this.records.update(row.serverId, {
            status: "failed",
            errorCode: "MCP_PACKAGE_INSTALL_FAILED",
          });
        } catch (error) {
          logFailure("record an interrupted MCP package install", error);
        }
    // An install deleted while AgentPier was stopped (or a restore) is missing: the CLIs
    // drop its entry now instead of starting a deleted program until a reinstall. Agents
    // in maintenance refuse changes; the next change or CLI session reconciles then.
    const missing =
      !this.changes.maintenance?.() &&
      this.records.all().some((row) => this.records.computedStatus(row) === "missing");
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
