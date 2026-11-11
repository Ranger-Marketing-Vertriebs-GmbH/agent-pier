import fs from "node:fs/promises";
import path from "node:path";
import { ownFolder } from "../sessions/session-own-folder.js";
import { validSession } from "./request-validation.js";

// Where the request broker keeps its files under the data directory:
//
// - `requests/`: one folder per session (`<id>/`) with its launch file and plugin
//   folders. A sandboxed session reads its own folder (the launch file is replaced
//   by rename) and writes only its own plugin folders in it. Launches from before
//   kept the same files directly in `requests/` (session-own-folder.js).
// - `request-runtime/`: the Claude hook dispatcher and nothing else. Sandboxed
//   sessions are granted it read-only, because their hooks run it.
// - `request-state/`: what only the server reads and writes (remembered approvals).
//   No session is granted it.
export const requestFolders = (dataDir) => ({
  directory: path.join(dataDir, "requests"),
  runtimeDirectory: path.join(dataDir, "request-runtime"),
  stateDirectory: path.join(dataDir, "request-state"),
});

/** Creates `directory` for the server alone (0700) and refuses one it does not own. */
export async function ownedFolder(directory, message) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()))
    throw Error(message);
  await fs.chmod(directory, 0o700);
}

/**
 * Creates the folder a new launch of `id` keeps its files in and returns its launch
 * file. A launch from before sessions had a folder of their own is discarded first,
 * like any other launch that still exists (`EEXIST`).
 */
export async function claimLaunchFolder(directory, id) {
  if (!validSession(id)) throw Error("Unsafe native request storage");
  await fs.access(path.join(directory, `${id}.launch.json`)).then(
    () => {
      throw Object.assign(Error("Native request launch already exists"), {
        code: "EEXIST",
      });
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const own = ownFolder(directory, id);
  await ownedFolder(own, "Unsafe native request storage");
  return path.join(own, `${id}.launch.json`);
}

/** Removes a launch's own folder and what a launch from before it left beside it. */
export async function removeLaunchFiles(directory, id) {
  // Removes recursively: never for a name that is not a session id.
  if (!validSession(id)) throw Error("Unsafe native request storage");
  await fs.rm(ownFolder(directory, id), { force: true, recursive: true });
  for (const suffix of [".launch.json", ".claude", ".claude-bridge", ".tui.json"])
    await fs.rm(path.join(directory, `${id}${suffix}`), { force: true, recursive: true });
}
