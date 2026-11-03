/*
 * The files of a Codex profile. `roots` are the CLI's folders below
 * profiles/<account>/ (the config root first); `credentials` are the files whose
 * presence means the profile is logged in; `backupAllowlist` names, per root, what
 * a host backup takes (operations/profile-allowlist.js); `configFiles` are the
 * config files below the config root.
 */
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
