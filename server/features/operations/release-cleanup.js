import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { releaseVersion } from "./release-archive.js";
import { compareReleaseVersions, applicationRoot } from "./version.js";
import { readJson } from "./files.js";
import { problem } from "../../lib/storage.js";

const cleanupError = (code, message, status = 409) =>
  Object.assign(problem(message, status), { code });

export function releaseProcesses() {
  return execFileSync("ps", ["-ww", "-u", String(process.getuid()), "-o", "command="], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8 * 1024 * 1024,
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
      const inUse = [commands, process.execPath, applicationRoot].some((value) =>
        targets.some(
          (candidate) => value.includes(candidate + path.sep) || value === candidate,
        ),
      );
      const reason =
        !stat.isDirectory() || stat.isSymbolicLink() || !manifestValid
          ? "unsafe"
          : version === active
            ? "active"
            : compareReleaseVersions(version, active) >= 0
              ? "newer"
              : busy
                ? "busy"
                : inUse
                  ? "inUse"
                  : null;
      return [{ version, canDelete: !reason, deleteReason: reason }];
    });
    return { available: true, versions };
  } catch {
    return blocked;
  }
}

export async function cleanupReleases(options, versions) {
  if (
    !Array.isArray(versions) ||
    !versions.length ||
    versions.length > 1000 ||
    new Set(versions).size !== versions.length
  )
    throw cleanupError("cleanupInvalid", "Invalid release cleanup selection.", 400);
  versions.forEach(releaseVersion);
  // Share the activation lock so cleanup cannot remove a rollback target mid-switch.
  const lock = path.join(options.dataDir, "operations/release-activation.lock");
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch {
    throw cleanupError("cleanupBusy", "Another release operation is pending.");
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
      throw cleanupError(
        "cleanupChanged",
        "The selected releases are no longer safe to remove. Refresh the list.",
        409,
      );
    const root = fs.realpathSync(options.installRoot);
    for (const version of versions) {
      await fs.promises.rm(path.join(root, "releases", version), { recursive: true });
      const receipts = path.join(options.dataDir, "operations/releases");
      for (const name of fs.readdirSync(receipts)) {
        if (!/^[a-f0-9-]+\.json$/.test(name)) continue;
        const file = path.join(receipts, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) continue;
        let receipt;
        try {
          receipt = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {
          continue;
        }
        if (receipt.version === version) fs.unlinkSync(file);
      }
    }
    return { removedVersions: versions };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}
