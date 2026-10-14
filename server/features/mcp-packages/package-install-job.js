import fs from "node:fs";
import { installNpm } from "./npm-package-install.js";
import { packageCode, packageError, packageProblem } from "./package-errors.js";
import { commitInstall, npmCommand, stageInstall } from "./package-store.js";
import { toolchainEntry } from "./toolchain-entry.js";

/** Store, file and toolchain errors carry paths: only a stable code leaves the service. */
export const installError = (error) =>
  packageError(error, "MCP_PACKAGE_INSTALL_FAILED", 500);
export const logFailure = (what, error, fallback = "MCP_PACKAGE_INSTALL_FAILED") =>
  console.error(`AgentPier could not ${what} (${packageCode(error, fallback)}).`);
/** The record fields a confirmed preview and its program determine. */
export const sourceFields = (preview, program) => ({
  ...preview.ref,
  program: program.name,
  programPath: program.path,
  allowScripts: preview.allowScripts,
  lock: preview.lockText,
  lockDigest: preview.digest,
  integrity: preview.integrity,
});

/**
 * Installs `preview` (or the stored lock) as a job of `service` (McpPackages) and
 * switches the server to it. Returns the job snapshot.
 */
export function runInstall(service, serverId, { preview, program, kind }) {
  let staged;
  try {
    staged = stageInstall(service.dataDir);
  } catch (error) {
    failed(service, serverId, null, error);
    throw installError(error);
  }
  const { installId, stage } = staged;
  return service.jobs.run(serverId, { kind, installId }, async (log, note) => {
    try {
      // Never install from an unchecked lock, even one checked at preview time.
      const checked = service.checkLock(preview.lockText, preview.ref, preview.integrity);
      if (checked.digest !== preview.digest)
        throw packageProblem("MCP_PACKAGE_INTEGRITY_MISMATCH", 502);
      const node = await service.toolchain("node");
      const toolchainDir = toolchainEntry(service.dataDir, node?.directory);
      if (!toolchainDir) throw packageProblem("MCP_PACKAGE_TOOLCHAIN_UNAVAILABLE", 503);
      note({ toolchainDir });
      await installNpm({
        directory: stage,
        manifestText: preview.manifestText,
        lockText: preview.lockText,
        ref: preview.ref,
        node,
        registry: service.registry,
        cacheDir: service.cacheDir,
        allowScripts: preview.allowScripts,
        execute: service.execute,
        environment: service.environment,
        log,
      });
      const receipt = {
        ...preview.ref,
        integrity: preview.integrity,
        lockDigest: checked.digest,
        allowScripts: preview.allowScripts,
        program,
        toolchain: { kind: "node", version: node.version, directory: toolchainDir },
      };
      commitInstall(service.dataDir, { installId, stage, receipt });
      const { command, leading } = npmCommand(
        service.dataDir,
        { ...receipt, installId },
        node,
      );
      await activate(
        service,
        serverId,
        {
          ...sourceFields(preview, program),
          installId,
          leadingArgs: leading.length,
          toolchainDir,
          status: "ready",
          errorCode: null,
        },
        command,
        leading,
      );
    } catch (error) {
      failed(service, serverId, stage, error);
      throw installError(error);
    }
  });
}

/** The stage goes; a first install ends `failed`, an update stays on its old install. */
function failed(service, serverId, stage, error) {
  try {
    if (stage) fs.rmSync(stage, { recursive: true, force: true });
    const current = service.records.get(serverId);
    if (current && current.status !== "ready")
      service.records.update(serverId, {
        status: "failed",
        errorCode: packageCode(error, "MCP_PACKAGE_INSTALL_FAILED"),
      });
  } catch (cleanup) {
    logFailure("record a failed MCP package install", cleanup);
  }
}

/**
 * The ready record first, then the command switch through the normal update path:
 * the reconciliation and the agents' apply it triggers already see the package
 * ready. A failed switch restores the previous record.
 */
export async function activate(service, serverId, fields, command, leading) {
  const previous = service.records.get(serverId);
  // Before the first install the stored args are the owner's only.
  const before = previous?.installId ? previous.leadingArgs : 0;
  service.switching.set(serverId, before);
  service.records.put(serverId, fields);
  try {
    await switchCommand(service, serverId, command, leading, before);
  } catch (error) {
    if (previous) service.records.put(serverId, previous);
    throw error;
  } finally {
    service.switching.delete(serverId);
  }
}

/** Through the normal update path: agents apply live, CLIs reconcile. One retry on 409. */
export async function switchCommand(service, serverId, command, leading, before) {
  for (let attempt = 0; ; attempt++) {
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
