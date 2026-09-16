import fs from "node:fs";
import path from "node:path";
export const toolIds = ["codex", "claude", "opencode", "gh"];
export function toolBinDirectories(dataDir) {
  return dataDir ? toolIds.map((id) => path.join(dataDir, "clis", id, "bin")) : [];
}
/**
 * The installed version directory behind a managed CLI, or null when the
 * executable was not installed by AgentPier. `<dataDir>/clis/<tool>` is a
 * symlink to the version directory the installer published under
 * `<dataDir>/clis/.packages/`, and an npm install puts a shebang script in its
 * `bin/` whose modules live beside it in that same directory. Callers that
 * confine a launch need the directory rather than the executable, because
 * reading the script alone leaves every import of it denied. The symlink is
 * resolved here so that a caller never depends on how the sandbox treats one.
 */
export function managedCliInstallation(dataDir, tool, command) {
  if (!dataDir || !toolIds.includes(tool) || typeof command !== "string") return null;
  try {
    const root = fs.realpathSync(path.join(dataDir, "clis", tool));
    const executable = fs.realpathSync(command);
    return executable.startsWith(root + path.sep) ? root : null;
  } catch {
    return null;
  }
}
