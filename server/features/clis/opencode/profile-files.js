// See codex/profile-files.js.
export const roots = ["config/opencode", "data/opencode"];
export const credentials = ["data/opencode/auth.json"];
export const backupAllowlist = {
  "config/opencode": {
    credentialFiles: [
      "opencode.json",
      "opencode.jsonc",
      "config.json",
      "tui.json",
      "tui.jsonc",
      "AGENTS.md",
    ],
    credentialTrees: [
      "agent",
      "agents",
      "command",
      "commands",
      "mode",
      "modes",
      "skill",
      "skills",
      "tool",
      "tools",
      "plugin",
      "plugins",
    ],
    excludedTrees: [],
    historyFiles: [],
    historyTrees: [],
    sqlite: null,
  },
  "data/opencode": {
    credentialFiles: ["auth.json", "mcp-auth.json"],
    credentialTrees: [],
    excludedTrees: [],
    historyFiles: [],
    historyTrees: ["storage"],
    sqlite: /^opencode\.db$/,
  },
};
export const configFiles = [
  "config.json",
  "opencode.json",
  "opencode.jsonc",
  "tui.json",
  "tui.jsonc",
];
