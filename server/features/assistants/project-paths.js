import fs from "node:fs";
import path from "node:path";
import { assistantProblem } from "./assistant-validation.js";
import { fold } from "./team-plugin/tool-guard.js";
import { runFence } from "../memory/project-folders.js";
import { repoConfigLocked } from "./project-config-lock.js";
import {
  assertOutsideDirs,
  protectedAncestors,
  protectedDirs,
  sameDir,
  writeProtectedRoots,
} from "./protected-dirs.js";

// Git internals hold credentials (remote URLs, hooks that run on the owner's next
// command): never read or written. Pipeline run worktrees belong to their runs.
const hidden = new Set([".git"].map(fold));
const readOnly = new Set([runFence].map(fold));
// Configuration that coding CLIs, editors, direnv or hook managers run as the owner
// when he opens or commits the folder (hooks, MCP servers, plugins, tasks,
// environments), and the instruction files his coding CLIs load from the working
// tree, often without approval. A restricted user's agent never writes there
// (`lockToolConfig`), so its files-only folder access cannot plant a command or an
// instruction for the owner's next session. The places the repository itself names
// (core.hooksPath, lefthook's source_dir, files instruction files import) are read
// per write (project-config-lock.js).
function lefthookNames() {
  return ["lefthook", "lefthook-local"].flatMap((base) =>
    ["yml", "yaml", "toml", "json", "jsonc"].flatMap((ext) => [
      `${base}.${ext}`,
      `.${base}.${ext}`,
    ]),
  );
}
export const toolConfigNames = [
  ".claude",
  ".codex",
  ".gemini",
  ".opencode",
  ".agents",
  "opencode.json",
  "opencode.jsonc",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  "AGENTS.override.md",
  "GEMINI.md",
  ".cursor",
  ".vscode",
  ".idea",
  ".devcontainer",
  ".husky",
  ".githooks",
  ".mcp.json",
  ".envrc",
  ".pre-commit-config.yaml",
  // mise runs `[env] _.source` and `[hooks] enter` when the owner enters the folder,
  // and trusts a changed file at a trusted path. `.mise/` and `mise/` (also under
  // `.config/`) hold its config directories; the segment match covers
  // `.config/mise.toml`.
  "mise.toml",
  ".mise.toml",
  "mise.local.toml",
  ".mise.local.toml",
  ".mise",
  "mise",
  // Every lefthook main and local configuration name (lefthookNames), which lefthook
  // also reads under .config/: the segment match covers that.
  ...lefthookNames(),
];
const toolConfig = new Set(toolConfigNames.map(fold));
const refused = () => assistantProblem("projectPathRefused", 403);
const toolConfigLocked = () => assistantProblem("projectToolConfigLocked", 403);
const inside = (parent, child) =>
  child === parent ||
  child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
const realpath = (value) => {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
};

/** The folder's real path; a missing or unreadable folder is "not found". */
export function realRoot(root) {
  const real = typeof root === "string" && path.isAbsolute(root) ? realpath(root) : null;
  if (!real || !fs.statSync(real).isDirectory()) throw assistantProblem("notFound", 404);
  return real;
}

// Segments below the root as given: relative to it, or absolute inside it (spelled
// with the registered or the real root). Never `..`, never a home, alias or URL form.
function segments(raw, roots) {
  if (raw === undefined || raw === "" || raw === ".") return [];
  if (
    typeof raw !== "string" ||
    raw.length > 4096 ||
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/.test(raw) ||
    /^(~|@|file:)/i.test(raw)
  )
    throw refused();
  let relative = raw;
  if (path.isAbsolute(raw)) {
    const root = roots.find((r) => inside(r, raw));
    if (!root) throw refused();
    relative = raw.slice(root.length);
  }
  const parts = relative.split("/").filter((part) => part && part !== ".");
  if (parts.includes("..")) throw refused();
  return parts;
}

function protectedParts(parts, write) {
  return parts.some(
    (part) => hidden.has(fold(part)) || (write && readOnly.has(fold(part))),
  );
}

// A write of a restricted user's agent into tool configuration, as given or resolved.
function lockedConfig(parts, write, lockToolConfig) {
  if (write && lockToolConfig && parts.some((part) => toolConfig.has(fold(part))))
    throw toolConfigLocked();
}

/**
 * Resolves `raw` inside a granted project folder, with the real path checked on
 * every call: symbolic links may point anywhere inside the folder, never out of it,
 * into `.git` or into `protectedRoots` (AgentPier's own data directory). Case
 * variants (".GIT") are caught by folding every segment, before and after links are
 * resolved; a protected root is also recognised by device and inode on every folder
 * from the file system root down (protected-dirs.js), so another case or a macOS
 * firmlink (/System/Volumes/Data) never reaches it, from a folder granted at `/`
 * either. A protected root whose identity cannot be determined refuses. A write
 * also stays out of the installed application (AGENTPIER_INSTALL_ROOT). Returns the real target (or, for a target that does not exist yet, the
 * real parent joined with the missing names), its relative POSIX path and whether
 * it exists. Refuses with `projectPathRefused` (403) otherwise, and with
 * `projectToolConfigLocked` (403) a write into tool configuration when
 * `lockToolConfig` is set (an agent of restricted users). `repoConfig` (default:
 * `lockToolConfig`) adds the places the repository itself names
 * (project-config-lock.js, a scan of the tree); `false` keeps only the fixed names,
 * for a folder that is no repository the owner opens (an agent's mail downloads).
 */
export function projectTarget(
  root,
  raw,
  {
    write = false,
    protectedRoots = [],
    lockToolConfig = false,
    repoConfig = lockToolConfig,
  } = {},
) {
  const real = realRoot(root);
  const parts = segments(raw, [...new Set([path.resolve(root), real])]);
  if (protectedParts(parts, write)) throw refused();
  lockedConfig(parts, write, lockToolConfig);
  // The deepest existing ancestor decides where links lead.
  let found = real,
    missing = [];
  for (let i = parts.length; i >= 0; i--) {
    const resolved = realpath(path.join(real, ...parts.slice(0, i)));
    if (resolved) {
      found = resolved;
      missing = parts.slice(i);
      break;
    }
  }
  const target = path.join(found, ...missing);
  if (!inside(real, found)) throw refused();
  const relative = path.relative(real, target).split(path.sep).filter(Boolean);
  if (protectedParts(relative, write)) throw refused();
  lockedConfig(relative, write, lockToolConfig);
  if (write && lockToolConfig && repoConfig && repoConfigLocked(real, target))
    throw toolConfigLocked();
  // A write also stays out of the installed application (writeProtectedRoots).
  const guardedRoots =
    write && protectedRoots.length
      ? [...protectedRoots, ...writeProtectedRoots()]
      : protectedRoots;
  for (const root of guardedRoots) {
    const guarded = realpath(root) || root;
    if (inside(guarded, target) || (write && inside(target, guarded))) throw refused();
  }
  // The same by device and inode, for every other spelling of a protected root.
  if (guardedRoots.length) {
    assertOutsideDirs(target, protectedDirs(guardedRoots, refused), refused);
    if (write && !missing.length) {
      const stat = fs.lstatSync(target, { bigint: true, throwIfNoEntry: false });
      if (!stat || sameDir(protectedAncestors(guardedRoots, refused), stat))
        throw refused();
    }
  }
  return {
    root: real,
    real: target,
    relative: relative.join("/"),
    exists: !missing.length,
  };
}
