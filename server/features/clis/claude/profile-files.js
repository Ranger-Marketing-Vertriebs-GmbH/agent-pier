// See codex/profile-files.js.
import path from "node:path";
import { configRoot } from "./profile.js";

export const roots = ["claude"];
export const credentials = ["claude/.credentials.json"];
export const backupAllowlist = {
  claude: {
    credentialFiles: [
      ".claude.json",
      ".credentials.json",
      "settings.json",
      "settings.local.json",
      "CLAUDE.md",
      "plugins/installed_plugins.json",
      "plugins/known_marketplaces.json",
      "plugins/config.json",
    ],
    // Hook scripts that settings.json runs; executable bits are not restored.
    credentialTrees: ["agents", "commands", "skills", "output-styles", "hooks"],
    excludedTrees: [],
    historyFiles: ["history.jsonl"],
    historyTrees: ["projects", "todos", "file-history"],
    sqlite: null,
  },
};
export const configFiles = ["settings.json"];
export const sharedDocuments = (root, env) => [
  {
    file: env.CLAUDE_CONFIG_DIR
      ? path.join(root, ".claude.json")
      : path.join(path.dirname(root), ".claude.json"),
    keys: ["mcpServers"],
    createIfMissing: true,
  },
  {
    file: path.join(root, "settings.json"),
    keys: ["enabledPlugins", "extraKnownMarketplaces"],
    createIfMissing: true,
  },
];
export const assetDirectories = [];
export const nativeFolder = "claude";
export function extensions({ env, home, account, boundary, skillScope }) {
  const dir = configRoot({ ...env, HOME: home }, home);
  const target = {
    path: path.join(dir, "skills"),
    boundary,
    ...skillScope(account.kind === "managed" ? "claudeProfileScope" : "claudeUserScope"),
  };
  return {
    files: [
      env.CLAUDE_CONFIG_DIR
        ? path.join(dir, ".claude.json")
        : path.join(home, ".claude.json"),
    ],
    key: "mcpServers",
    target,
    sources: [target],
  };
}
