import { packageProblem } from "./package-errors.js";
import {
  activate,
  installError,
  logFailure,
  stopIfCancelled,
} from "./package-install-job.js";
import { readInstall, rewriteReceipt } from "./package-store.js";
import { chooseProgram, programName } from "./program-select.js";

/** The record and receipt of a `choosing` server whose install is still there, else null. */
function choosingReceipt(service, id) {
  const row = service.records.get(id);
  if (row?.status !== "choosing" || !row.installId) return null;
  const receipt = readInstall(service.dataDir, row.installId, row.lockDigest);
  return Array.isArray(receipt?.programs) ? { row, receipt } : null;
}

/** The programs the owner may choose from; none unless the record is `choosing`. */
export function choosablePrograms(service, id) {
  return choosingReceipt(service, id)?.receipt.programs.map((p) => p.name) ?? [];
}

/**
 * Activates the program `wanted` of a build that named several (owner decision 1):
 * the install stays, only its receipt, the record and the server command change.
 * Returns the job snapshot; a refused choice starts no job.
 */
export function chooseInstalledProgram(service, id, wanted) {
  const found = choosingReceipt(service, id);
  if (!found) throw packageProblem("MCP_PACKAGE_INVALID", 400);
  service.requireIdle(id);
  const { row, receipt } = found;
  const valid = typeof wanted === "string" && programName.test(wanted);
  // Only one of the receipt's own programs; several always need a name.
  const chosen = chooseProgram(receipt.programs, valid ? wanted : null);
  return service.jobs.run(
    id,
    { kind: "activate", installId: row.installId },
    async (_log, note, signal) => {
      let rewritten = false;
      try {
        note({ toolchainDir: row.toolchainDir });
        const adapter = service.adapterOf(row.registry);
        const toolchain = await service.toolchain(adapter.toolchainKind);
        stopIfCancelled(signal);
        const next = { ...receipt, program: chosen };
        // The adapter checks that the program stays inside the install.
        const { command, leading } = adapter.command(
          service.dataDir,
          { ...next, installId: row.installId },
          toolchain,
        );
        rewriteReceipt(service.dataDir, row.installId, next);
        rewritten = true;
        await activate(
          service,
          id,
          {
            ...row,
            program: chosen.name,
            programPath: chosen.path,
            leadingArgs: leading.length,
            status: "ready",
            errorCode: null,
          },
          command,
          leading,
          { signal },
        );
      } catch (error) {
        // activate() restored the choosing record; its receipt waits for a choice again.
        if (rewritten && service.records.get(id)?.status === "choosing")
          try {
            rewriteReceipt(service.dataDir, row.installId, receipt);
          } catch (restore) {
            logFailure("restore an MCP package receipt", restore);
          }
        throw installError(error);
      }
    },
  );
}
