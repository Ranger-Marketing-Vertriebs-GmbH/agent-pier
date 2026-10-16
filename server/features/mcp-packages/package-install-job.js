import fs from "node:fs";
import os from "node:os";
import { packageCode, packageError, packageProblem } from "./package-errors.js";
import { choosingReceipt, commitInstall, stageInstall } from "./package-store.js";
import { chooseProgram } from "./program-select.js";
import { toolchainEntry } from "./toolchain-entry.js";

/** Store, file and toolchain errors carry paths: only a stable code leaves the service. */
export const installError = (error) =>
  packageError(error, "MCP_PACKAGE_INSTALL_FAILED", 500);
export const logFailure = (what, error, fallback = "MCP_PACKAGE_INSTALL_FAILED") =>
  console.error(`AgentPier could not ${what} (${packageCode(error, fallback)}).`);
/** Stops a cancelled job between its steps; npm and uv stop through the signal. */
export function stopIfCancelled(signal) {
  if (signal?.aborted) throw packageProblem("MCP_PACKAGE_CANCELLED", 409);
}
/** The record fields a confirmed preview and its program determine. */
export const sourceFields = (preview, program) => ({
  ...preview.ref,
  program: program?.name ?? "",
  programPath: program?.path ?? "",
  allowScripts: preview.allowScripts,
  // Whether the lock needs a build: a reinstall without receipt syncs the same way.
  needsScripts: preview.needsScripts === true,
  constraints: preview.constraints ?? [],
  lock: preview.lockText,
  lockDigest: preview.digest,
  integrity: preview.integrity,
});

const withReal = (dir) => {
  try {
    return [dir, fs.realpathSync(dir)];
  } catch {
    return [dir];
  }
};
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * Replaces the data dir with `<data>` and the home dir with `~` (each also by its real
 * path), longest first and only as a whole path (never inside a URL or a longer name):
 * npm output names local paths.
 */
export function pathRedactor(dataDir, home = os.homedir()) {
  const pairs = [
    ...withReal(dataDir).map((dir) => [dir, "<data>"]),
    ...withReal(home).map((dir) => [dir, "~"]),
  ]
    .filter(([dir]) => typeof dir === "string" && dir.length > 1)
    .sort((a, b) => b[0].length - a[0].length);
  if (!pairs.length) return (text) => String(text);
  const labels = new Map([...pairs].reverse());
  const pattern = new RegExp(
    `(?<![\\w.~-])(?:${pairs.map(([dir]) => escapeRegExp(dir)).join("|")})(?=$|[/\\s"'\`()[\\]{},:;])`,
    "g",
  );
  return (text) => String(text).replace(pattern, (dir) => labels.get(dir));
}

/**
 * Installs `preview` (or the stored lock) as a job of `service` (McpPackages) and
 * switches the server to it. Returns the job snapshot.
 */
export function runInstall(service, serverId, { preview, program, kind }) {
  // Checked before staging, so a busy server leaves no stage behind.
  service.requireIdle(serverId);
  const redact = pathRedactor(service.dataDir);
  let staged;
  try {
    staged = stageInstall(service.dataDir);
  } catch (error) {
    failed(service, serverId, null, error);
    throw installError(error);
  }
  const { installId, stage } = staged;
  return service.jobs.run(serverId, { kind, installId }, async (jobLog, note, signal) => {
    const log = (text) => jobLog(redact(text));
    try {
      const { ref } = preview;
      const adapter = service.adapterOf(ref.registry);
      // Never install from an unchecked lock, even one checked at preview time.
      const checked = service.checkStored({
        ...ref,
        lock: preview.lockText,
        integrity: preview.integrity,
      });
      if (checked.digest !== preview.digest)
        throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
      // A first toolchain download runs to its end; the cancel takes effect after it.
      const toolchain = await service.toolchain(adapter.toolchainKind);
      stopIfCancelled(signal);
      const toolchainDir = toolchainEntry(service.dataDir, toolchain?.directory);
      if (!toolchainDir) throw packageProblem("MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);
      note({ toolchainDir });
      await adapter.install({
        directory: stage,
        preview,
        toolchain,
        registry: service.registries[ref.registry],
        cacheDir: service.cacheDir(ref.registry),
        execute: service.execute,
        environment: service.environment,
        log,
        signal,
      });
      // Some packages name their programs for sure only once installed (and built).
      const installed = adapter.programsAfterInstall(stage, ref);
      const wanted = program?.name || undefined;
      // Several programs and none named yet: the owner picks one (owner decision 1),
      // unless the server runs an install now. Its command points into that install,
      // which a `choosing` record would let prune delete: it is refused instead.
      const choosing =
        !!installed &&
        installed.length > 1 &&
        wanted === undefined &&
        service.records.get(serverId)?.status !== "ready";
      const chosen = choosing
        ? null
        : installed
          ? chooseProgram(installed, wanted)
          : program;
      const receipt = {
        ...ref,
        integrity: preview.integrity,
        lockDigest: checked.digest,
        allowScripts: preview.allowScripts,
        needsScripts: preview.needsScripts === true,
        constraints: preview.constraints ?? [],
        program: chosen,
        // What program-choice.js offers while the record is `choosing`.
        ...(installed ? { programs: installed } : {}),
        toolchain: {
          kind: adapter.toolchainKind,
          version: adapter.toolchainVersion(toolchain),
          directory: toolchainDir,
        },
      };
      stopIfCancelled(signal);
      commitInstall(service.dataDir, { installId, stage, receipt });
      if (choosing) {
        // The server keeps what it runs now; only the record learns the new install.
        const current = service.records.get(serverId);
        service.records.put(serverId, {
          ...sourceFields(preview, null),
          installId,
          leadingArgs: service.storedLeading(serverId, current),
          toolchainDir,
          status: "choosing",
          errorCode: null,
        });
        return;
      }
      const { command, leading } = adapter.command(
        service.dataDir,
        { ...receipt, installId },
        toolchain,
      );
      await activate(
        service,
        serverId,
        {
          ...sourceFields(preview, chosen),
          installId,
          leadingArgs: leading.length,
          toolchainDir,
          status: "ready",
          errorCode: null,
        },
        command,
        leading,
        { signal },
      );
    } catch (error) {
      failed(service, serverId, stage, error);
      throw installError(error);
    }
  });
}

/**
 * The stage goes; a first install ends `failed`, an update stays on its old install,
 * and a record waiting for its program keeps waiting while that install is intact.
 */
function failed(service, serverId, stage, error) {
  try {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    const current = service.records.get(serverId);
    const code = packageCode(error, "MCP_PACKAGE_INSTALL_FAILED");
    // A deleted server has no record left; one that remains was stopped by a shutdown,
    // whose cancel is a plain failed install (the cancel message names a deletion).
    if (
      current &&
      current.status !== "ready" &&
      !choosingReceipt(service.dataDir, current)
    )
      service.records.update(serverId, {
        status: "failed",
        errorCode: code === "MCP_PACKAGE_CANCELLED" ? "MCP_PACKAGE_INSTALL_FAILED" : code,
      });
  } catch (cleanup) {
    logFailure("record a failed MCP package install", cleanup);
  }
}

/** Whether the stored server already runs the switch's command and generated args. */
export const switchedTo = (server, { command, leading }) =>
  server?.command === command &&
  leading.every((arg, index) => server.args?.[index] === arg);

/**
 * The ready record first, then the command switch through the normal update path:
 * the reconciliation and the agents' apply it triggers already see the package
 * ready. A failed switch restores the previous record.
 */
export async function activate(
  service,
  serverId,
  fields,
  command,
  leading,
  { signal } = {},
) {
  const previous = service.records.get(serverId);
  // Before the first install the stored args are the owner's only.
  const before = previous?.installId ? previous.leadingArgs : 0;
  // The new install's id is in the command (PyPI) or its first arg (npm), so the
  // stored definition says unambiguously whether the switch has committed.
  // The install (and toolchain) the server runs until the switch committed: prune
  // keeps them, so a failed switch goes back to an install that still exists.
  service.switching.set(serverId, {
    before,
    after: leading.length,
    command,
    leading,
    running: previous?.installId ?? null,
    runningToolchain: previous?.toolchainDir ?? null,
  });
  service.records.put(serverId, fields);
  try {
    await switchCommand(service, serverId, command, leading, before, { signal });
  } catch (error) {
    // A deleted server keeps no record: its row (and the one put above) went with it.
    // A server that remains (a shutdown cancel) gets its previous record back.
    if (previous && service.records.get(serverId))
      service.records.put(serverId, previous);
    throw error;
  } finally {
    service.switching.delete(serverId);
  }
}

/** Through the normal update path: agents apply live, CLIs reconcile. One retry on 409. */
export async function switchCommand(
  service,
  serverId,
  command,
  leading,
  before,
  { signal } = {},
) {
  for (let attempt = 0; ; attempt++) {
    // A cancel that came during the first attempt starts no retry.
    if (attempt > 0) stopIfCancelled(signal);
    const server = service.servers.get(serverId);
    const owner = (server.args || []).slice(before);
    try {
      await service.changes.update(
        serverId,
        { revision: server.revision, command, args: [...leading, ...owner] },
        { confirmStdio: true },
      );
      return;
    } catch (error) {
      if (error?.status !== 409 || attempt > 0) throw error;
    }
  }
}
