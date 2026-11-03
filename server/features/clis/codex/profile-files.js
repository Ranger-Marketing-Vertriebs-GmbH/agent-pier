/*
 * The files of a Codex profile. `roots` are the CLI's folders below
 * profiles/<account>/ (the config root first); `credentials` are the files whose
 * presence means the profile is logged in; `backupAllowlist` names, per root, what
 * a host backup takes (operations/profile-allowlist.js); `configFiles` are the
 * config files below the config root.
 */
import path from "node:path";
import { configRoot } from "./profile.js";

export const roots = ["codex"];
export const credentials = ["codex/auth.json"];
export const backupAllowlist = {
  codex: {
    credentialFiles: [
      "auth.json",
      "config.toml",
      ".credentials.json",
      "AGENTS.md",
      "AGENTS.override.md",
    ],
    credentialTrees: ["prompts", "skills", "agents", "commands", "rules"],
    // Skills Codex installs itself on every start.
    excludedTrees: ["skills/.system"],
    historyFiles: ["history.jsonl", "session_index.jsonl"],
    historyTrees: ["sessions", "archived_sessions", "generated_images"],
    sqlite: /^thread_history[A-Za-z0-9_.-]*\.sqlite$/,
  },
};
export const configFiles = ["config.toml"];
// The documents of the config root that profiles share (configuration.js): the file and
// the keys that travel with it.
export const sharedDocuments = (root) => [
  {
    file: path.join(root, "config.toml"),
    keys: ["mcp_servers", "plugins", "marketplaces", "skills", "agents"],
    createIfMissing: true,
  },
];
// Extra asset folders below the config root, after skills, agents, commands, plugins.
export const assetDirectories = [".tmp/marketplaces"];
// The CLI's folder below profiles/<account>/; the canonical home folder is "." + it.
export const nativeFolder = "codex";
// Where the extensions page finds this CLI's MCP servers and skills. `shared` is the
// shared user skill source, `skillScope(key)` builds a scope label.
export function extensions({ env, home, boundary, shared, skillScope, sharedProfiles }) {
  const dir = configRoot({ ...env, HOME: home }, home);
  return {
    files: [path.join(dir, "config.toml")],
    key: "mcp_servers",
    target: sharedProfiles
      ? {
          path: path.join(dir, "skills"),
          boundary,
          ...skillScope("codexProfileSkillScope"),
        }
      : shared,
    sources: [
      shared,
      {
        path: path.join(dir, "skills"),
        boundary,
        ...skillScope("codexProfileSkillScope"),
        readOnly: !sharedProfiles,
      },
      {
        path: "/etc/codex/skills",
        boundary: "/etc/codex",
        ...skillScope("systemReadOnlyScope"),
        readOnly: true,
      },
    ],
  };
}
// How the CLI stores an Agency agent: a TOML file or a markdown file with this front matter.
export const agents = { format: "toml", frontmatter: {} };
