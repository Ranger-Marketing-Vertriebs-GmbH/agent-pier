/**
 * What a host backup takes from a managed CLI profile (docs/backups.md). Everything
 * is named here; a file or folder a CLI adds later (caches, logs, telemetry, plugin
 * copies) is never captured until it is listed.
 *
 * - `credentials`: login, configuration and the user's own instructions, skills and
 *   agents. They go into the passphrase capsule and only with credentials.
 * - `history`: the CLI's conversation history. It is public, like AgentPier's own
 *   session history, and only part of a backup with history.
 * - `sqlite`: history databases, captured as consistent snapshots.
 *
 * Paths are relative to a native root inside `profiles/<account>/` or
 * `profiles/<account>/providers/<provider>/`.
 */
export const nativeRoots = Object.freeze({
  codex: ["codex"],
  claude: ["claude"],
  opencode: ["config/opencode", "data/opencode"],
});
const rules = {
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
    credentialTrees: ["agents", "commands", "skills", "output-styles"],
    excludedTrees: [],
    historyFiles: ["history.jsonl"],
    historyTrees: ["projects", "todos", "file-history"],
    sqlite: null,
  },
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
// Files whose presence means a restored profile is still logged in.
const loginFiles = {
  codex: ["codex/auth.json"],
  claude: ["claude/.credentials.json"],
  opencode: ["data/opencode/auth.json"],
};
// Never captured anywhere inside an allowed tree.
const excludedSegment =
  /^(?:node_modules|cache|\.cache|\.git|logs?|tmp|\.tmp)$|\.before-sharing/;
const volatileName = /-(?:wal|shm|journal)$|\.lock$|\.tmp$/;
const segment = /^[A-Za-z0-9_-]+$/;

/** Whether a directory `relative` below root `root` can hold captured files. */
export function descend(root, relative) {
  const rule = rules[root],
    parts = relative.split("/");
  if (parts.some((part) => excludedSegment.test(part))) return false;
  if (rule.excludedTrees.some((tree) => relative === tree)) return false;
  const top = parts[0];
  return (
    rule.credentialTrees.includes(top) ||
    rule.historyTrees.includes(top) ||
    rule.credentialFiles.some((file) => file.startsWith(`${relative}/`))
  );
}

/** "credentials", "history", "sqlite" or null for a file below a native root. */
export function classify(root, relative) {
  const rule = rules[root];
  if (!rule) return null;
  const parts = relative.split("/");
  if (
    volatileName.test(relative) ||
    parts.some((part) => excludedSegment.test(part)) ||
    rule.excludedTrees.some((tree) => relative.startsWith(`${tree}/`))
  )
    return null;
  if (rule.credentialFiles.includes(relative)) return "credentials";
  if (parts.length === 1) {
    if (rule.historyFiles.includes(relative)) return "history";
    return rule.sqlite?.test(relative) ? "sqlite" : null;
  }
  if (rule.credentialTrees.includes(parts[0])) return "credentials";
  if (rule.historyTrees.includes(parts[0])) return "history";
  return null;
}

/** Splits `profiles/<account>/[providers/<provider>/]<root>/<relative>`. */
export function profilePath(name) {
  const parts = name.split("/");
  if (parts[0] !== "profiles" || !segment.test(parts[1] || "")) return null;
  let rest = parts.slice(2);
  if (rest[0] === "providers") {
    if (!segment.test(rest[1] || "")) return null;
    rest = rest.slice(2);
  }
  const root =
    rest[0] === "config" || rest[0] === "data" ? rest.slice(0, 2).join("/") : rest[0];
  if (!rules[root]) return null;
  return {
    account: parts[1],
    root,
    relative: rest.slice(root.split("/").length).join("/"),
  };
}

/**
 * The capture kind of an archive member path: "secret" for an account's API key,
 * "credentials" or "history" (including history databases), or null.
 */
export function profileMemberKind(name) {
  if (/^profiles\/[A-Za-z0-9_-]+\/secret\.json$/.test(name)) return "secret";
  const located = profilePath(name);
  if (!located?.relative) return null;
  const kind = classify(located.root, located.relative);
  return kind === "sqlite" ? "history" : kind;
}

/** Whether member `name` is a login of `account`, directly or for one of its providers. */
export function isLoginFile(account, name) {
  const located = profilePath(name);
  return (
    located?.account === account.id &&
    (loginFiles[account.tool] || []).includes(`${located.root}/${located.relative}`)
  );
}
