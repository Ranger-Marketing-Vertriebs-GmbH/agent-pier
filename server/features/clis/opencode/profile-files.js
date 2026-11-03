// See codex/profile-files.js.
import path from "node:path";
import { configRoot } from "./profile.js";

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
export const sharedDocuments = (root) =>
  configFiles.map((name) => ({
    file: path.join(root, name),
    keys: name.startsWith("tui.") ? ["plugin"] : ["mcp", "plugin", "agent"],
    createIfMissing: ["opencode.jsonc", "tui.jsonc"].includes(name),
  }));
export const assetDirectories = ["plugin"];
export const nativeFolder = "config/opencode";
export function extensions({ env, home, account, boundary, shared, skillScope }) {
  const dir = configRoot({ ...env, HOME: home }, home);
  const target = {
    path: path.join(dir, "skills"),
    boundary,
    ...skillScope(
      account.kind === "managed" ? "openCodeProfileScope" : "openCodeUserScope",
    ),
  };
  return {
    // MCP servers sit in the config files; the TUI files hold no `mcp` key.
    files: configFiles
      .filter((name) => !name.startsWith("tui."))
      .map((name) => path.join(dir, name)),
    key: "mcp",
    target,
    sources: [
      target,
      { ...shared, readOnly: true },
      {
        path: path.join(home, ".claude/skills"),
        boundary: home,
        scope: "Claude-kompatibel · geteilt",
        readOnly: true,
      },
    ],
  };
}
// See codex/profile-files.js.
export const agents = { format: "markdown", frontmatter: { mode: "subagent" } };
