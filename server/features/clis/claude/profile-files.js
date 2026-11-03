// See codex/profile-files.js.
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
