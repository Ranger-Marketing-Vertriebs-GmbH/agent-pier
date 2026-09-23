import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { folder, readJson, identifier } from "./files.js";
import { releaseVersion, releaseManifest } from "./release-archive.js";
import { restartService, checkHealth } from "./release-service.js";
import { problem } from "../../lib/storage.js";
import { requireDataCompatibility } from "./release-schema.js";

export function switchRelease(root, version) {
  releaseVersion(version);
  const current = path.join(root, "current"),
    temporary = path.join(root, `.current-${randomUUID()}`);
  if (fs.existsSync(current) && !fs.lstatSync(current).isSymbolicLink())
    throw problem(serverMessages.releases.pointerNotOwned, 409);
  fs.symlinkSync(`releases/${version}`, temporary);
  try {
    fs.renameSync(temporary, current);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export function installLauncher({ installRoot, dataDir }) {
  const root = folder(installRoot),
    bin = folder(path.join(root, "bin"));
  if (
    !path.isAbsolute(dataDir) ||
    fs.realpathSync(dataDir).startsWith(`${fs.realpathSync(root)}/releases/`)
  )
    throw problem(serverMessages.releases.stableDataRequired);
  const quotedData = `'${dataDir.replaceAll("'", "'\\''")}'`;
  const launcher = `#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexport AGENTPIER_INSTALL_ROOT="$ROOT"\nif [ -z "\${AGENTPIER_DATA_DIR:-}" ]; then AGENTPIER_DATA_DIR=${quotedData}; fi\nexport AGENTPIER_DATA_DIR\nexec "$ROOT/current/bin/node" "$ROOT/current/server/index.js" "$@"\n`;
  const file = path.join(bin, "agentpier");
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
    throw problem(serverMessages.releases.launcherLinked);
  fs.writeFileSync(file, launcher, { mode: 0o755 });
  fs.chmodSync(file, 0o755);
  return file;
}
export async function activateRelease(
  input,
  { restart = restartService, health = checkHealth } = {},
) {
  const root = fs.realpathSync(input.installRoot),
    dataDir = fs.realpathSync(input.dataDir);
  if (dataDir === root || dataDir.startsWith(`${root}/releases/`))
    throw problem(serverMessages.releases.activationDataRequired, 409);
  const receipt = input.stagedId
    ? readJson(
        path.join(dataDir, "operations/releases", `${identifier(input.stagedId)}.json`),
        null,
      )
    : { version: input.version };
  if (!receipt) throw problem(serverMessages.releases.stagedNotFound, 404);
  const version = releaseVersion(receipt.version),
    target = path.join(root, "releases", version);
  if (fs.realpathSync(target) !== target)
    throw problem(serverMessages.releases.directoryLinked);
  requireDataCompatibility(
    releaseManifest(readJson(path.join(target, "release.json"))),
    dataDir,
  );
  const currentPath = path.join(root, "current");
  if (!fs.existsSync(currentPath) || !fs.lstatSync(currentPath).isSymbolicLink())
    throw problem(serverMessages.releases.initialReleaseRequired, 409);
  const previous = fs.readlinkSync(currentPath);
  if (!/^releases\/[^/]+$/.test(previous))
    throw problem(serverMessages.releases.pointerOutside, 409);
  const from = releaseVersion(previous.slice("releases/".length));
  const previousManifest = releaseManifest(
    readJson(path.join(root, previous, "release.json")),
  );
  if (from === version) throw problem(serverMessages.releases.alreadyActive, 409);
  const lock = path.join(dataDir, "operations/release-activation.lock");
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch {
    throw problem(serverMessages.releases.activationPending, 409);
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, from, to: version }));
  try {
    // A cleanup may have finished between initial validation and lock acquisition.
    if (fs.realpathSync(target) !== target)
      throw problem(serverMessages.releases.directoryLinked);
    requireDataCompatibility(
      releaseManifest(readJson(path.join(target, "release.json"))),
      dataDir,
    );
    switchRelease(root, version);
    try {
      await restart({ installRoot: root, dataDir });
      if (
        !(await health({
          port: input.port || 4380,
          version,
          previousInstanceId: input.previousInstanceId,
        }))
      )
        throw problem(serverMessages.releases.healthFailed, 503);
    } catch {
      try {
        requireDataCompatibility(previousManifest, dataDir);
      } catch {
        throw Object.assign(problem(serverMessages.releases.healthFailedSchema, 503), {
          result: {
            from,
            to: version,
            activated: false,
            rolledBack: false,
            recovered: false,
          },
        });
      }
      switchRelease(root, from);
      let recovered = false;
      try {
        await restart({ installRoot: root, dataDir });
        recovered = await health({ port: input.port || 4380, version: from });
      } catch {}
      throw Object.assign(
        problem(
          recovered
            ? serverMessages.releases.healthFailedRestored
            : serverMessages.releases.healthFailedRecovery,
          503,
        ),
        { result: { from, to: version, activated: false, rolledBack: true, recovered } },
      );
    }
    return { from, to: version, activated: true, rolledBack: false };
  } finally {
    fs.closeSync(fd);
    fs.rmSync(lock, { force: true });
  }
}
