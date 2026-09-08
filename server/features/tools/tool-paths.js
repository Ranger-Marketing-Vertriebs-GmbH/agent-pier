import path from "node:path";
export const toolIds = ["codex", "claude", "opencode", "gh"];
export function toolBinDirectories(dataDir) {
  return dataDir ? toolIds.map((id) => path.join(dataDir, "clis", id, "bin")) : [];
}
