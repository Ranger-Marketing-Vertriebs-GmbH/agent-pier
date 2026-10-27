import { record } from "../extensions/mcp-config.js";
import { packageProblem } from "./package-errors.js";

// Packages AgentPier installs from a lockfile committed with its own code (the managed
// REA tool, AGENTPIER-104): no preview, no owner program choice and never any install
// script. The lock is checked against the pinned integrity before npm runs, and the
// install runs through the same job, commit and switch as every other package.
const invalid = () => packageProblem("MCP_PACKAGE_INVALID", 400);

/** The preview `reinstall()` builds, from a committed lock instead of a stored one. */
export function frozenPreview(service, { ref, lockText, integrity }) {
  const adapter = service.adapterOf(ref?.registry);
  // Throws MCP_PACKAGE_INTEGRITY_MISMATCH when the lock is not the pinned version.
  const checked = service.checkStored({ ...ref, lock: lockText, integrity });
  return {
    ref: { registry: ref.registry, name: ref.name, version: ref.version },
    allowScripts: false,
    constraints: [],
    integrity,
    manifestText: adapter.manifestText(ref),
    lockText,
    digest: checked.digest,
    needsScripts: checked.needsScripts === true,
  };
}

/**
 * Creates the row of a frozen package (with its pending record and `managed` marker in
 * the row's own transaction) and starts its install job. The pinned program is used
 * as is: the lock was checked when it was committed.
 */
export async function createFrozenServer(
  service,
  input,
  { clis, frozen, program, managed } = {},
) {
  if (
    !record(input) ||
    input.transport !== "stdio" ||
    input.command !== undefined ||
    input.source !== undefined
  )
    throw invalid();
  const preview = frozenPreview(service, frozen);
  let server;
  // Until its job runs, the new record is installing, not orphaned.
  service.claiming += 1;
  try {
    server = await service.changes.create(input, {
      confirmStdio: true,
      pendingCommand: true,
      packageRecord: service.pendingRecord({ preview, program }),
      managed,
      ...(clis === undefined ? {} : { clis }),
    });
    service.install(server.id, { preview, program, kind: "install" });
  } finally {
    service.claiming -= 1;
  }
  return service.servers.get(server.id);
}

/** Installs the frozen lock for a server that already has a record of this package. */
export function installFrozen(service, serverId, frozen, program, kind) {
  const row = service.records.get(serverId);
  if (
    !row ||
    row.registry !== frozen?.ref?.registry ||
    row.name !== frozen.ref.name ||
    !["install", "update", "reinstall"].includes(kind)
  )
    throw invalid();
  return service.install(serverId, {
    preview: frozenPreview(service, frozen),
    program,
    kind,
  });
}

/** Resolves once the current job of `serverId` ended (at once without one); never rejects. */
export function jobSettled(service, serverId) {
  const job = service.jobs.jobs.get(serverId);
  return Promise.resolve(job?.promise).then(
    () => {},
    () => {},
  );
}
