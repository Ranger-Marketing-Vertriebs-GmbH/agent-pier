import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { failure } from "./memory-validation.js";
import { gitMessageEnvironment } from "../../lib/git-locale.js";
const execute = promisify(execFile);

// Where registered projects are looked up (one per open ProjectMemory).
const registries = new Set();
/**
 * Lets `projectScope` reuse a registered project when only the device number of
 * its folder changed: macOS assigns volumes a new device number at boot, so the
 * same folder (same path and inode) would otherwise get a new project ID after
 * every restart. `lookup({ id, kind, path, ino })` returns the registered ID or
 * null; the returned function removes the registry again.
 */
export function useProjectRegistry(lookup) {
  registries.add(lookup);
  return () => registries.delete(lookup);
}
/** Identity of a folder ignoring its device number, or null when malformed. */
export function stableIdentity(identity) {
  try {
    const [kind, place, , ino] = JSON.parse(identity);
    return typeof place === "string" && typeof ino === "string"
      ? JSON.stringify([kind, place, ino])
      : null;
  } catch {
    return null;
  }
}
/**
 * The project ID of an identity `[kind, path, dev, ino]`: the registered project
 * of the same folder when one exists (see useProjectRegistry), else its hash.
 * `known: false` skips the registries (a restore maps a backup's own rows).
 */
export function projectId([kind, place, dev, ino], { known = true } = {}) {
  const id = createHash("sha256")
    .update(JSON.stringify([kind, place, dev, ino]))
    .digest("hex");
  if (!known) return id;
  for (const lookup of registries) {
    let found = null;
    try {
      found = lookup({ id, kind, path: place, ino });
    } catch {
      // A closed or unreadable registry knows no project.
    }
    if (found) return found;
  }
  return id;
}
export async function projectScope(cwd, options = {}) {
  if (typeof cwd !== "string" || !path.isAbsolute(cwd) || /[\x00-\x1f]/.test(cwd))
    throw failure(serverMessages.memory.invalidProjectDirectory);
  let canonical;
  try {
    canonical = fs.realpathSync(cwd);
    if (!fs.statSync(canonical).isDirectory()) throw Error();
  } catch {
    throw failure(serverMessages.memory.projectDirectoryUnavailable, 404);
  }
  let common = canonical,
    kind = "directory",
    root = canonical;
  try {
    const env = gitMessageEnvironment({
      PATH: process.env.PATH,
      HOME: canonical,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    });
    const result = await execute(
      "git",
      [
        "-C",
        canonical,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
      ],
      { env, timeout: 3000, maxBuffer: 16384, encoding: "utf8" },
    );
    const values = result.stdout.trimEnd().split("\n");
    if (values.length !== 2 || values.some((value) => !path.isAbsolute(value)))
      throw failure(serverMessages.memory.gitProjectUnidentified, 409);
    common = fs.realpathSync(values[0]);
    root = fs.realpathSync(values[1]);
    kind = "git";
  } catch (error) {
    if (error.status) throw error;
    if (error.killed || error.code === "ETIMEDOUT")
      throw failure(serverMessages.memory.gitDiscoveryTimedOut, 409);
    if (error.code !== "ENOENT" && !/not a git repository/i.test(error.stderr || ""))
      throw failure(serverMessages.memory.gitProjectUnidentified, 409);
  }
  const stat = fs.statSync(common, { bigint: true });
  const parts = [kind, common, String(stat.dev), String(stat.ino)];
  return {
    id: projectId(parts, options),
    name: path.basename(root),
    cwd: root,
    kind,
    identity: JSON.stringify(parts),
  };
}
