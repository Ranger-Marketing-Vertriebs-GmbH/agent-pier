import fs from "node:fs/promises";
import path from "node:path";

// Where the request broker keeps its files under the data directory:
//
// - `requests/`: one launch file and the plugin folders per session. A sandboxed
//   session reads this folder (its own launch file is replaced by rename) and writes
//   only its own plugin folders.
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
