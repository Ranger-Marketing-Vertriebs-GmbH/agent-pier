import { codingCliIds } from "../clis/catalog.js";
import { cliDriver } from "../clis/drivers.js";

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
export const nativeRoots = Object.freeze(
  Object.fromEntries(codingCliIds().map((id) => [id, cliDriver(id).profileFiles.roots])),
);
const rules = Object.assign(
  {},
  ...codingCliIds().map((id) => cliDriver(id).profileFiles.backupAllowlist),
);
// Files whose presence means a restored profile is still logged in.
const loginFiles = Object.fromEntries(
  codingCliIds().map((id) => [id, cliDriver(id).profileFiles.credentials]),
);
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
  // Only clean relative paths: no empty, "." or ".." segment, no backslash or NUL.
  if (
    typeof name !== "string" ||
    /[\\\x00-\x1f]/.test(name) ||
    name.split("/").some((part) => !part || part === "." || part === "..")
  )
    return null;
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
