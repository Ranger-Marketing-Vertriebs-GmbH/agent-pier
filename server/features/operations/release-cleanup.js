import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { releaseVersion } from "./release-archive.js";
import { compareReleaseVersions, applicationRoot } from "./version.js";
import { readJson } from "./files.js";
import { problem } from "../../lib/storage.js";
import { releaseSessionReferences } from "./release-references.js";
import { processExecutable } from "../../lib/process-identity.js";

const cleanupError = (code, message, status = 409) =>
  Object.assign(problem(message, status), { code });

export function releaseProcessReferences(output, executableFor = () => null) {
  return output
    .split("\n")
    .map((line) => {
      // tmux keeps the first client's launch command in its process title for its
      // entire lifetime. Only its executable is a live dependency, not those old args.
      const tmux = /^(\s*\d+\s+\d+\s+)?((?:\S*\/)?tmux)\s+/.exec(line);
      if (tmux) return `${tmux[1] || ""}${tmux[2]}`;
      // macOS truncates a non-final comm column even with -ww. Recognize a
      // possible truncated executable prefix, then verify the full comm alone.
      // Linux reports tmux's server/client title instead; verify /proc's executable.
      // Never infer tmux identity from a mention elsewhere in its arguments.
      const columns = /^(\s*(\d+)\s+\d+\s+)(\S+)\s+(\S+)/.exec(line);
      if (!columns) return line;
      const [, prefix, pid, comm, command] = columns;
      const titled = comm === "tmux:" && ["server", "client"].includes(command);
      if (
        !titled &&
        (!path.isAbsolute(command) ||
          path.basename(command) !== "tmux" ||
          !command.startsWith(comm) ||
          command === comm)
      )
        return line;
      try {
        const executable = executableFor(pid);
        if (
          typeof executable === "string" &&
          path.isAbsolute(executable) &&
          path.basename(executable) === "tmux" &&
          (titled || executable === command)
        )
          return `${prefix}${executable}`;
      } catch {
        // Unavailable or changed process evidence must keep the release protected.
      }
      return line;
    })
    .join("\n");
}
export function releaseProcesses() {
  return releaseProcessReferences(
    execFileSync(
      "ps",
      ["-ww", "-u", String(process.getuid()), "-o", "pid=,ppid=,comm=,command="],
      { encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024 },
    ),
    processExecutable,
  );
}
/** Staged receipts in <dataDir>/operations/releases: [{ id, version, file }]. */
function stagedReceipts(dataDir) {
  const directory = path.join(dataDir, "operations/releases");
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    if (!/^[a-f0-9-]+\.json$/.test(name)) return [];
    const file = path.join(directory, name);
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return [];
      const { version } = JSON.parse(fs.readFileSync(file, "utf8"));
      return [{ id: name.slice(0, -".json".length), version, file }];
    } catch {
      return [];
    }
  });
}
export function cleanupState({
  installRoot,
  dataDir,
  processes = releaseProcesses,
  ignoreCleanupLock = false,
}) {
  const blocked = { versions: [], available: false };
  if (!installRoot) return blocked;
  try {
    const root = fs.realpathSync(installRoot);
    const directory = path.join(root, "releases");
    if (fs.realpathSync(directory) !== directory) return blocked;
    const current = path.join(root, "current");
    if (!fs.lstatSync(current).isSymbolicLink()) return blocked;
    const pointer = fs.readlinkSync(current);
    if (!/^releases\/[^/]+$/.test(pointer)) return blocked;
    const active = releaseVersion(pointer.slice("releases/".length));
    const activePath = path.join(directory, active);
    if (fs.realpathSync(current) !== activePath) return blocked;
    const data = fs.realpathSync(dataDir);
    if (data === root || data === directory || data.startsWith(directory + path.sep))
      return blocked;
    const busy =
      !ignoreCleanupLock &&
      fs.existsSync(path.join(dataDir, "operations/release-activation.lock"));
    let commands;
    try {
      commands = processes();
    } catch {
      return blocked;
    }
    const receipts = stagedReceipts(dataDir);
    const versions = fs.readdirSync(directory).flatMap((version) => {
      try {
        releaseVersion(version);
      } catch {
        return [];
      }
      const target = path.join(directory, version);
      const stat = fs.lstatSync(target);
      let manifestValid = false;
      try {
        manifestValid = readJson(path.join(target, "release.json")).version === version;
      } catch {}
      const targets = [target, path.join(installRoot, "releases", version)];
      const references = releaseSessionReferences(commands, targets);
      // Every process that references the release holds it, except orphaned ones
      // that only run its node (release-references.js).
      const orphans = new Set(references.orphaned.map((item) => String(item.pid)));
      const holding = commands
        .split("\n")
        .filter((line) => !orphans.has(/^\s*(\d+)\s/.exec(line)?.[1]))
        .join("\n");
      const inUse = [holding, process.execPath, applicationRoot].some((value) =>
        targets.some(
          (candidate) => value.includes(candidate + path.sep) || value === candidate,
        ),
      );
      const newer = compareReleaseVersions(version, active) > 0;
      const stagedIds = receipts
        .filter((receipt) => receipt.version === version)
        .map((receipt) => receipt.id)
        .sort();
      // A newer version can be deleted only as a staged package (its receipt); one
      // installed without a receipt may be another install's target and stays.
      const reason =
        !stat.isDirectory() || stat.isSymbolicLink() || !manifestValid
          ? "unsafe"
          : version === active
            ? "active"
            : newer && !stagedIds.length
              ? "newer"
              : busy
                ? "busy"
                : inUse
                  ? "inUse"
                  : null;
      return [
        {
          version,
          canDelete: !reason,
          deleteReason: reason,
          newer,
          stagedIds,
          sessionIds: references.sessionIds,
          nodeOnlyProcesses: references.nodeOnly,
          helperProcesses: references.helperReferences,
          unidentifiedProcesses: references.unidentified,
          orphanedProcesses: references.orphaned,
        },
      ];
    });
    // Newest first, in the same order as the release history.
    versions.sort((a, b) => compareReleaseVersions(b.version, a.version));
    return { available: true, versions };
  } catch {
    return blocked;
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Stops the orphaned processes the owner chose for a version (cleanupState lists
 * them): each must still be one of that version's orphans; SIGTERM, then SIGKILL
 * after a grace period for one that ignores it. Never any other process.
 */
export async function stopOrphanedProcesses(
  options,
  version,
  pids,
  { graceMs = 2000 } = {},
) {
  releaseVersion(version);
  if (
    !Array.isArray(pids) ||
    !pids.length ||
    pids.length > 100 ||
    pids.some((pid) => !Number.isSafeInteger(pid) || pid <= 1) ||
    new Set(pids).size !== pids.length
  )
    throw cleanupError("cleanupInvalid", serverMessages.releases.cleanupInvalid, 400);
  // Only an old version's orphans: never the active or a newer version's processes.
  const entry = () =>
    cleanupState(options).versions?.find((item) => item.version === version);
  const orphans = () =>
    new Set((entry()?.orphanedProcesses || []).map((item) => item.pid));
  const current = entry();
  if (
    !current ||
    current.newer ||
    ["active", "newer", "unsafe"].includes(current.deleteReason)
  )
    throw cleanupError("cleanupInvalid", serverMessages.releases.cleanupInvalid, 400);
  const known = orphans();
  if (pids.some((pid) => !known.has(pid)))
    throw cleanupError("cleanupChanged", serverMessages.releases.cleanupChanged, 409);
  const stopped = [];
  for (const pid of pids)
    try {
      process.kill(pid, "SIGTERM");
      stopped.push(pid);
    } catch {
      /* Already gone. */
    }
  for (let waited = 0; waited < graceMs && stopped.some(alive); waited += 100)
    await new Promise((resolve) => setTimeout(resolve, 100));
  // Only a process that is still the same orphan is killed outright.
  const still = orphans();
  for (const pid of stopped)
    if (alive(pid) && still.has(pid))
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
  for (let waited = 0; waited < 1000 && stopped.some(alive); waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  return { stopped };
}

// A retired release directory (releases/.deleting-<uuid>): never a valid version name,
// so listings skip it; a later cleanup removes what an interrupted one left behind.
const DELETING = ".deleting-";
async function removeRetired(retired) {
  try {
    await fs.promises.rm(retired, { recursive: true });
  } catch {
    // The version is already gone; the leftover is swept by a later cleanup.
  }
}
async function sweepDeleting(directory) {
  for (const name of fs.readdirSync(directory)) {
    if (!name.startsWith(DELETING)) continue;
    const target = path.join(directory, name);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory() && !stat.isSymbolicLink()) await removeRetired(target);
  }
}
export async function cleanupReleases(options, versions) {
  if (
    !Array.isArray(versions) ||
    !versions.length ||
    versions.length > 1000 ||
    new Set(versions).size !== versions.length
  )
    throw cleanupError("cleanupInvalid", serverMessages.releases.cleanupInvalid, 400);
  versions.forEach(releaseVersion);
  // Share the activation lock so cleanup cannot remove a rollback target mid-switch.
  const lock = path.join(options.dataDir, "operations/release-activation.lock");
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch {
    throw cleanupError("cleanupBusy", serverMessages.releases.cleanupBusy);
  }
  try {
    // Inspect while holding our lock; only this known lock is ignored.
    const state = cleanupState({ ...options, ignoreCleanupLock: true });
    if (
      !state.available ||
      versions.some(
        (version) =>
          !state.versions.some((item) => item.version === version && item.canDelete),
      )
    )
      throw cleanupError("cleanupChanged", serverMessages.releases.cleanupChanged, 409);
    const directory = path.join(fs.realpathSync(options.installRoot), "releases");
    await sweepDeleting(directory);
    const stagedIds = {};
    for (const version of versions) {
      // Retire the version atomically first: listings and activation never see a
      // half-removed directory, and its receipts go before any byte is removed.
      const retired = path.join(directory, `${DELETING}${randomUUID()}`);
      fs.renameSync(path.join(directory, version), retired);
      const receipts = stagedReceipts(options.dataDir)
        .filter((receipt) => receipt.version === version)
        .sort((a, b) => a.id.localeCompare(b.id));
      for (const receipt of receipts) fs.unlinkSync(receipt.file);
      if (receipts.length) stagedIds[version] = receipts.map((receipt) => receipt.id);
      await removeRetired(retired);
    }
    return {
      removedVersions: versions,
      ...(Object.keys(stagedIds).length ? { stagedIds } : {}),
    };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
