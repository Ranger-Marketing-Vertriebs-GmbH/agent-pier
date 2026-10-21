import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fold } from "./team-plugin/tool-guard.js";
import { runFence } from "../memory/project-folders.js";

// The tool-configuration lock (project-paths.js) matches fixed names. A repository
// also names, in its own files, more places that run or instruct as the owner: the
// hook folder Git runs from (core.hooksPath), lefthook's script folders
// (source_dir, source_dir_local) and the files that locked instruction files import
// (CLAUDE.md and GEMINI.md `@path`, opencode.json `instructions`). This module reads
// those settings for every write of a restricted user's agent, so a write there is
// locked too. Unreadable or oversized files lock nothing more.

const MAX_BYTES = 256 * 1024;
// Claude Code follows imports up to five hops deep.
const MAX_HOPS = 5;
const MAX_PARENTS = 64;
const MAX_FOLDERS = 10000;
const skipped = new Set([".git", "node_modules", runFence]);
const importing = ["CLAUDE.md", "CLAUDE.local.md", "GEMINI.md", "AGENTS.md"];
const opencode = ["opencode.json", "opencode.jsonc"];
const lefthook = ["lefthook", "lefthook-local"].flatMap((base) =>
  ["yml", "yaml", "toml", "json", "jsonc"].flatMap((ext) => [
    `${base}.${ext}`,
    `.${base}.${ext}`,
    `.config/${base}.${ext}`,
  ]),
);

function readSmall(file) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

// The real path, or for a missing one its deepest real ancestor joined with the rest.
function settle(target) {
  const missing = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(target);
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

const unquote = (value) => value.trim().replace(/^(["'])(.*)\1$/, "$2");
const expand = (value, base) =>
  value.startsWith("~/")
    ? path.join(os.homedir(), value.slice(2))
    : path.resolve(base, value);

// The working tree's top and Git's config files for it (a linked worktree's `.git`
// is a file naming its own Git directory, whose commondir holds the shared config).
function gitConfigs(root) {
  let top = root;
  for (let i = 0; i < MAX_PARENTS; i++) {
    const dotGit = path.join(top, ".git");
    let stat = null;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      /* Not here. */
    }
    if (stat?.isDirectory())
      return { top, common: dotGit, files: [path.join(dotGit, "config")] };
    if (stat?.isFile()) {
      const named = /^gitdir:\s*(.+)$/m.exec(readSmall(dotGit) || "")?.[1]?.trim();
      if (!named) return null;
      const gitDir = path.resolve(top, named);
      const common = readSmall(path.join(gitDir, "commondir"))?.trim();
      const shared = common ? path.resolve(gitDir, common) : gitDir;
      return {
        top,
        common: shared,
        files: [path.join(shared, "config"), path.join(gitDir, "config.worktree")],
      };
    }
    const parent = path.dirname(top);
    if (parent === top) return null;
    top = parent;
  }
  return null;
}

// Every working tree whose Git settings reach the target: the folder's own
// repository, the linked worktrees its Git directory lists (Git resolves a relative
// hooksPath and lefthook reads its configuration per worktree), and every nested
// repository or worktree on the way down to the target or found in the tree.
function workingTrees(root, target, nested) {
  const tops = new Set();
  const add = (top) => {
    const git = top && gitConfigs(top);
    if (!git || tops.has(git.top)) return;
    tops.add(git.top);
    let entries = [];
    try {
      entries = fs.readdirSync(path.join(git.common, "worktrees")).slice(0, MAX_PARENTS);
    } catch {
      /* No linked worktrees. */
    }
    for (const name of entries) {
      const dotGit = readSmall(
        path.join(git.common, "worktrees", name, "gitdir"),
      )?.trim();
      if (dotGit) add(path.dirname(path.resolve(git.common, "worktrees", name, dotGit)));
    }
  };
  add(root);
  const below = path.relative(root, target).split(path.sep).filter(Boolean);
  for (let i = 1; i <= below.length; i++) {
    const dir = path.join(root, ...below.slice(0, i));
    if (fs.existsSync(path.join(dir, ".git"))) add(dir);
  }
  for (const dir of nested) add(dir);
  return [...tops].map((top) => gitConfigs(top)).filter(Boolean);
}

const MAX_INCLUDES = 10;

// Every core.hooksPath a working tree's Git config sets, and the config files it
// includes (`[include]` and `[includeIf]` `path`, followed whatever their condition):
// an included file inside the folder is itself a place that runs commands.
function gitSettings(git, included) {
  const hooks = [];
  const seen = new Set();
  const visit = (file, depth) => {
    if (depth > MAX_INCLUDES || seen.has(file)) return;
    seen.add(file);
    let section = "";
    for (const line of (readSmall(file) || "").split(/\r?\n/)) {
      const header = /^\s*\[\s*([^\]\s"]+)/.exec(line);
      if (header) {
        section = header[1].toLowerCase();
        continue;
      }
      const entry = /^\s*([a-z0-9-]+)\s*=\s*(.*?)\s*(?:[#;].*)?$/i.exec(line);
      if (!entry || !entry[2]) continue;
      const key = entry[1].toLowerCase();
      const value = unquote(entry[2]);
      if (section === "core" && key === "hookspath") hooks.push(expand(value, git.top));
      if ((section === "include" || section === "includeif") && key === "path") {
        const next = expand(value, path.dirname(file));
        included.push(next);
        visit(next, depth + 1);
      }
    }
  };
  for (const file of git.files) visit(file, 0);
  return hooks;
}

// lefthook's script folders in a working tree: its defaults and what its
// configurations set.
function lefthookFolders(root) {
  const found = [".lefthook", ".lefthook-local"].map((name) => path.join(root, name));
  for (const name of lefthook) {
    const text = readSmall(path.join(root, name));
    if (!text) continue;
    for (const match of text.matchAll(
      /["']?source_dir(?:_local)?["']?\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,#}]+)/g,
    ))
      if (unquote(match[1])) found.push(path.resolve(root, unquote(match[1])));
  }
  return found;
}

// `@path` imports of a Markdown instruction file, relative to that file.
function markdownImports(file, text) {
  const imports = [];
  const plain = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  for (const match of plain.matchAll(/(?:^|\s)@([^\s<>()[\]"'`]+)/g)) {
    const raw = match[1].replace(/[.,;:!?]+$/, "");
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    imports.push(expand(raw, path.dirname(file)));
  }
  return imports;
}

// OpenCode's `instructions`: paths and globs relative to the project.
function opencodeInstructions(root, patterns) {
  const files = [];
  for (const name of opencode)
    for (const dir of [root, path.join(root, ".opencode")]) {
      const text = readSmall(path.join(dir, name));
      const list = text && /"instructions"\s*:\s*\[([^\]]*)\]/.exec(text)?.[1];
      if (!list) continue;
      for (const [, entry] of list.matchAll(/"((?:[^"\\]|\\.)*)"/g)) {
        if (!entry || /^[a-z][a-z0-9+.-]*:/i.test(entry)) continue;
        if (/[*?[{]/.test(entry)) patterns.push(globPattern(expand(entry, root)));
        else files.push(expand(entry, root));
      }
    }
  return files;
}

function globPattern(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (c === "*") source += "[^/]*";
    else if (c === "?") source += "[^/]";
    else source += c.replace(/[\\^$.+()|{}[\]]/g, "\\$&");
  }
  return new RegExp(`^${fold(source)}$`);
}

// Folders that may hold instruction files: the root, .claude/, every folder from the
// root down to the target, and the rest of the tree up to MAX_FOLDERS (dependencies
// and Git internals left out), as nested instruction files load with their folder.
// Also the nested repositories and worktrees found on the way. `complete` is false
// when the tree has more folders than that: the lock then fails closed.
function scanTree(root, target) {
  const dirs = [root, path.join(root, ".claude")];
  const below = path.relative(root, path.dirname(target)).split(path.sep).filter(Boolean);
  for (let i = 1; i <= below.length; i++)
    dirs.push(path.join(root, ...below.slice(0, i)));
  const nested = [];
  const queue = [root];
  let complete = true;
  for (let next = 0; next < queue.length; next++) {
    const dir = queue[next];
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".git" && dir !== root) nested.push(dir);
      if (!entry.isDirectory() || skipped.has(entry.name)) continue;
      if (queue.length >= MAX_FOLDERS) {
        complete = false;
        break;
      }
      const child = path.join(dir, entry.name);
      dirs.push(child);
      queue.push(child);
    }
    if (!complete) break;
  }
  return { dirs: [...new Set(dirs)], nested, complete };
}

// Instruction files that import others, then whatever they import, up to MAX_HOPS deep.
function importedFiles(dirs) {
  let current = dirs.flatMap((dir) => importing.map((name) => path.join(dir, name)));
  const seen = new Set();
  const found = [];
  for (let hop = 0; hop <= MAX_HOPS && current.length; hop++) {
    const next = [];
    for (const file of current) {
      const text = readSmall(file);
      if (!text) continue;
      const key = fold(settle(file));
      if (seen.has(key)) continue;
      seen.add(key);
      for (const imported of markdownImports(file, text)) {
        found.push(imported);
        next.push(imported);
      }
    }
    current = next;
  }
  return found;
}

/**
 * Whether a write to `target` (a real path inside the real `root`) reaches a place
 * the repository's own settings make run or instruct as the owner: a Git or
 * lefthook hook folder of any working tree in the folder, a Git config file such a
 * tree includes, or a file a locked instruction file imports. A folder that holds
 * such a place counts too, as replacing it would replace them. A folder too large to
 * search completely locks every write.
 */
export function repoConfigLocked(root, target) {
  const scan = scanTree(root, target);
  if (!scan.complete) return true;
  const patterns = [];
  const included = [];
  const trees = workingTrees(root, target, scan.nested);
  const tops = [root, ...trees.map((git) => git.top)];
  const folders = [
    ...trees.flatMap((git) => gitSettings(git, included)),
    ...tops.flatMap(lefthookFolders),
  ].map(settle);
  const files = [
    ...included,
    ...importedFiles(scan.dirs),
    ...tops.flatMap((top) => opencodeInstructions(top, patterns)),
  ].map(settle);
  const wanted = fold(target);
  const within = (parent, child) =>
    child === parent ||
    child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
  return (
    folders.some(
      (folder) => within(fold(folder), wanted) || within(wanted, fold(folder)),
    ) ||
    files.some((file) => within(wanted, fold(file))) ||
    patterns.some((pattern) => pattern.test(wanted))
  );
}
