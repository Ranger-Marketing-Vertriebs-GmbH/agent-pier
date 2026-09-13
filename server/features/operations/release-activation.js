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
    throw problem("Release pointer must be an owned symlink.", 409);
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
    throw problem("A stable data directory outside releases is required.");
  const quotedData = `'${dataDir.replaceAll("'", "'\\''")}'`;
  const launcher = `#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexport AGENTPIER_INSTALL_ROOT="$ROOT"\nif [ -z "\${AGENTPIER_DATA_DIR:-}" ]; then AGENTPIER_DATA_DIR=${quotedData}; fi\nexport AGENTPIER_DATA_DIR\nexec "$ROOT/current/bin/node" "$ROOT/current/server/index.js" "$@"\n`;
  const file = path.join(bin, "agentpier");
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink())
    throw problem("Launcher must not be a symlink.");
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
    throw problem("Release activation requires a stable external data directory.", 409);
  const receipt = input.stagedId
    ? readJson(
        path.join(dataDir, "operations/releases", `${identifier(input.stagedId)}.json`),
        null,
      )
    : { version: input.version };
  if (!receipt) throw problem("Staged release not found.", 404);
  const version = releaseVersion(receipt.version),
    target = path.join(root, "releases", version);
  if (fs.realpathSync(target) !== target)
    throw problem("Release directory must not be a link.");
  requireDataCompatibility(
    releaseManifest(readJson(path.join(target, "release.json"))),
    dataDir,
  );
  const currentPath = path.join(root, "current");
  if (!fs.existsSync(currentPath) || !fs.lstatSync(currentPath).isSymbolicLink())
    throw problem("Install the initial versioned release before activation.", 409);
  const previous = fs.readlinkSync(currentPath);
  if (!/^releases\/[^/]+$/.test(previous))
    throw problem("Release pointer is outside its owned layout.", 409);
  const from = releaseVersion(previous.slice("releases/".length));
  const previousManifest = releaseManifest(
    readJson(path.join(root, previous, "release.json")),
  );
  if (from === version) throw problem("That release is already active.", 409);
  const lock = path.join(dataDir, "operations/release-activation.lock");
  let fd;
  try {
    fd = fs.openSync(lock, "wx", 0o600);
  } catch {
    throw problem(
      "Another release activation is pending. Inspect it before retrying.",
      409,
    );
  }
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, from, to: version }));
  try {
    // A cleanup may have finished between initial validation and lock acquisition.
    if (fs.realpathSync(target) !== target)
      throw problem("Release directory must not be a link.");
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
        throw problem("Release health verification failed.", 503);
    } catch {
      try {
        requireDataCompatibility(previousManifest, dataDir);
      } catch {
        throw Object.assign(
          problem(
            "Release health failed after a schema change; automatic rollback is incompatible and the new data was preserved.",
            503,
          ),
          {
            result: {
              from,
              to: version,
              activated: false,
              rolledBack: false,
              recovered: false,
            },
          },
        );
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
            ? "Release health verification failed; the previous release was restored."
            : "Release health verification failed; previous pointer restored but service recovery needs attention.",
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
