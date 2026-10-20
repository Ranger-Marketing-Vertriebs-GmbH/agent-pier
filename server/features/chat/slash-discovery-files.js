import fs from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";

// What slash discovery reads from a CLI's own folders: the frontmatter of command,
// prompt and skill documents, and nothing else. A document's body never leaves the
// server; only a validated name, a short description and an argument hint do.

export const discoveryLimits = Object.freeze({
  commands: 500,
  directoryEntries: 400,
  documentBytes: 16 * 1024,
  description: 240,
  argumentHint: 120,
  depth: 3,
});

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,99}$/;

/** A one-line text without control characters, cut to `limit`, or undefined. */
export function shortText(value, limit) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text;
}

/** A command entry, or null when its name is not one a CLI would accept. */
export function commandEntry({ name, description, argumentHint, kind, scope, plugin }) {
  if (typeof name !== "string" || !NAME.test(name)) return null;
  const entry = { name, kind, scope };
  const summary = shortText(description, discoveryLimits.description);
  const hint = shortText(argumentHint, discoveryLimits.argumentHint);
  if (summary) entry.description = summary;
  if (hint) entry.argumentHint = hint;
  if (plugin && NAME.test(plugin)) entry.plugin = plugin;
  return entry;
}

/**
 * Collects what one discovery read: the entries and every path it looked at, so the
 * cache can tell when one of them changed (slash-command-service.js).
 */
export class DiscoveryScan {
  constructor() {
    this.entries = [];
    this.watched = new Set();
  }
  watch(file) {
    this.watched.add(file);
  }
  add(input) {
    if (this.entries.length >= discoveryLimits.commands) return;
    const entry = commandEntry(input);
    if (entry) this.entries.push(entry);
  }
}

/**
 * The frontmatter of a Markdown document as a plain object ({} without one). A file
 * that is too large, unreadable or a symbolic link where none is allowed gives null.
 */
export async function readFrontmatter(file, { scan, links = true } = {}) {
  scan?.watch(file);
  let handle;
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() && !links) return null;
    handle = await fs.open(file, "r");
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(Math.min(info.size, discoveryLimits.documentBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8").replace(/^﻿/, "");
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match) return {};
    const lines = plainFields(match[1]);
    let value = null;
    try {
      const document = parseDocument(match[1], { uniqueKeys: false });
      if (!document.errors.length) value = document.toJS({ maxAliasCount: 0 });
    } catch {
      value = null;
    }
    // The CLIs read frontmatter leniently: `argument-hint: [file] [line]` is no valid
    // YAML, and `[file]` alone would be a list, so the hint keeps its written form.
    const metadata =
      value && typeof value === "object" && !Array.isArray(value) ? value : lines;
    if (lines["argument-hint"] !== undefined)
      metadata["argument-hint"] = lines["argument-hint"];
    return metadata;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Top-level `key: value` lines, unquoted; a fallback for frontmatter YAML rejects. */
function plainFields(text) {
  const fields = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Za-z][\w-]*):[ \t]*(.*?)[ \t]*$/.exec(line);
    if (!match || !match[2] || /^[|>]/.test(match[2])) continue;
    const quoted = /^(["'])(.*)\1$/.exec(match[2]);
    fields[match[1]] = quoted ? quoted[2] : match[2];
  }
  return fields;
}

/** A JSON (or JSONC without comments) file as an object, or null. */
export async function readJsonFile(file, scan) {
  scan?.watch(file);
  try {
    const text = await fs.readFile(file, "utf8");
    if (text.length > 4 * 1024 * 1024) return null;
    const value = JSON.parse(text);
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

/** Directory entries, sorted, capped; symbolic links followed only when allowed. */
export async function listDirectory(directory, { scan, links = true } = {}) {
  scan?.watch(directory);
  try {
    if (!links && (await isLink(directory))) return [];
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const result = [];
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (result.length >= discoveryLimits.directoryEntries) break;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(directory, entry.name);
      let directoryLike = entry.isDirectory(),
        fileLike = entry.isFile();
      if (entry.isSymbolicLink()) {
        if (!links) continue;
        const target = await fs.stat(full).catch(() => null);
        directoryLike = !!target?.isDirectory();
        fileLike = !!target?.isFile();
      }
      result.push({
        name: entry.name,
        path: full,
        directory: directoryLike,
        file: fileLike,
      });
    }
    return result;
  } catch {
    return [];
  }
}

/**
 * Markdown documents below `directory`, with their path relative to it (without the
 * extension), up to `depth` folders deep.
 */
export async function markdownDocuments(directory, options = {}) {
  const { depth = discoveryLimits.depth } = options;
  const found = [];
  const walk = async (folder, prefix, level) => {
    for (const entry of await listDirectory(folder, options)) {
      if (found.length >= discoveryLimits.directoryEntries) return;
      if (entry.file && /\.md$/i.test(entry.name))
        found.push({ path: entry.path, relative: prefix + entry.name.slice(0, -3) });
      else if (entry.directory && level < depth)
        await walk(entry.path, `${prefix}${entry.name}/`, level + 1);
    }
  };
  await walk(directory, "", 0);
  return found;
}

/**
 * Skill folders: `directory` itself when it holds a SKILL.md, otherwise each child
 * folder that holds one.
 */
export async function skillFolders(directory, options = {}) {
  const own = path.join(directory, "SKILL.md");
  if (await isFile(own, options)) return [{ folder: directory, file: own }];
  const folders = [];
  for (const entry of await listDirectory(directory, options)) {
    if (!entry.directory) continue;
    const file = path.join(entry.path, "SKILL.md");
    if (await isFile(file, options)) folders.push({ folder: entry.path, file });
  }
  return folders;
}

async function isFile(file, { links = true } = {}) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return links && (await fs.stat(file)).isFile();
    return stat.isFile();
  } catch {
    return false;
  }
}

/** Whether `file` is a symbolic link (a project folder must not be one). */
export async function isLink(file) {
  try {
    return (await fs.lstat(file)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Whether `child` lies inside `parent` (both resolved). */
export function inside(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** The first value of the given frontmatter keys that is a string. */
export function field(metadata, ...keys) {
  for (const key of keys) if (typeof metadata?.[key] === "string") return metadata[key];
  return undefined;
}
