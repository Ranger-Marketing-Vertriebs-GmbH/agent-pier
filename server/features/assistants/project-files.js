import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { projectTarget } from "./project-paths.js";
import { fold } from "./team-plugin/tool-guard.js";

// What one tool call reads, lists or searches at most; writes come through the
// bridge, whose request limit (128 KiB) bounds them further.
export const fileLimits = {
  readBytes: 1048576,
  readChars: 200000,
  readLines: 2000,
  listEntries: 1000,
  searchFiles: 5000,
  searchMatches: 200,
  // Search reads synchronously; this bounds the time one call holds the server.
  searchBytes: 33554432,
  lineChars: 300,
};
// Never descended into by search: dependencies and the runs' own checkouts.
const skipped = new Set([".git", "node_modules", ".agentpier-worktrees"].map(fold));
const unsuitable = () => assistantProblem("projectFileUnsuitable", 400);
const missing = () => assistantProblem("notFound", 404);
const { O_RDONLY, O_NOFOLLOW } = fs.constants;

function openRegular(file) {
  let fd;
  try {
    fd = fs.openSync(file, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw missing();
    // ELOOP: the last name is a link that does not resolve inside the folder.
    throw unsuitable();
  }
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    throw unsuitable();
  }
  return { fd, stat };
}

// UTF-8 text of a regular file below the read limit; binary content is refused.
function readText(file) {
  const { fd, stat } = openRegular(file);
  try {
    if (stat.size > fileLimits.readBytes) throw unsuitable();
    const buffer = Buffer.alloc(stat.size);
    let read = 0;
    while (read < stat.size) {
      const n = fs.readSync(fd, buffer, read, stat.size - read, read);
      if (!n) break;
      read += n;
    }
    const bytes = buffer.subarray(0, read);
    if (bytes.subarray(0, 8192).includes(0)) throw unsuitable();
    return { text: bytes.toString("utf8"), stat };
  } finally {
    fs.closeSync(fd);
  }
}

/** A directory listing: names, kinds and file sizes, sorted, capped. */
export function listFolder(root, raw, options) {
  const target = projectTarget(root, raw, options);
  if (!target.exists) throw missing();
  let entries;
  try {
    entries = fs.readdirSync(target.real, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOTDIR") throw unsuitable();
    throw missing();
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    path: target.relative || ".",
    entries: entries.slice(0, fileLimits.listEntries).map((entry) => {
      const kind = entry.isDirectory()
        ? "directory"
        : entry.isFile()
          ? "file"
          : entry.isSymbolicLink()
            ? "link"
            : "other";
      let size;
      if (kind === "file")
        try {
          size = fs.lstatSync(path.join(target.real, entry.name)).size;
        } catch {}
      return { name: entry.name, kind, ...(size !== undefined ? { size } : {}) };
    }),
    truncated: entries.length > fileLimits.listEntries,
  };
}

/** Text of one file, by 1-based line `offset` and line `limit`. */
export function readFile(
  root,
  raw,
  { offset = 1, limit = fileLimits.readLines, ...options } = {},
) {
  const target = projectTarget(root, raw, options);
  if (!target.exists) throw missing();
  const { text } = readText(target.real);
  const lines = text.split("\n");
  const start = Math.max(1, offset);
  let content = lines
    .slice(start - 1, start - 1 + Math.min(limit, fileLimits.readLines))
    .join("\n");
  const cut = content.length > fileLimits.readChars;
  if (cut) content = content.slice(0, fileLimits.readChars);
  const shown = content ? content.split("\n").length : 0;
  return {
    path: target.relative,
    content,
    offset: start,
    totalLines: lines.length,
    truncated: cut || start - 1 + shown < lines.length,
  };
}

// Creates each missing folder below the real parent one by one, refusing a name
// that turns out to be anything but a plain directory.
function ensureFolders(target) {
  const parent = path.dirname(target.real);
  const names = path.relative(target.root, parent).split(path.sep).filter(Boolean);
  let current = target.root;
  for (const name of names) {
    current = path.join(current, name);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (error.code !== "EEXIST") throw unsuitable();
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsuitable();
  }
  return parent;
}

// Replaces the file through a temporary sibling and a rename: a link at the final
// name is replaced itself, never followed; an existing file keeps its mode.
function replaceFile(target, text) {
  let mode = 0o666 & ~process.umask();
  if (target.exists) {
    const stat = fs.lstatSync(target.real);
    // A second hard link could be a file outside the folder.
    if (!stat.isFile() || stat.nlink > 1) throw unsuitable();
    mode = stat.mode & 0o7777;
  }
  const parent = ensureFolders(target);
  const temporary = path.join(
    parent,
    `.${path.basename(target.real)}.agentpier-${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(temporary, "wx", mode);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, target.real);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return Buffer.byteLength(text);
}

/** Creates or replaces one file with `content`. */
export function writeFile(root, raw, content, options = {}) {
  const target = projectTarget(root, raw, { ...options, write: true });
  if (!target.relative) throw unsuitable();
  const created = !target.exists;
  if (target.exists && !fs.lstatSync(target.real).isFile()) throw unsuitable();
  return { path: target.relative, bytes: replaceFile(target, content), created };
}

/** Replaces `oldText` (exactly once, or every time with `replaceAll`) by `newText`. */
export function editFile(
  root,
  raw,
  { oldText, newText, replaceAll = false },
  options = {},
) {
  const target = projectTarget(root, raw, { ...options, write: true });
  if (!target.exists) throw missing();
  const { text } = readText(target.real);
  const count = oldText ? text.split(oldText).length - 1 : 0;
  if (!count || (count > 1 && !replaceAll))
    throw assistantProblem("projectEditNoMatch", 409);
  const next = replaceAll
    ? text.split(oldText).join(newText)
    : text.replace(oldText, () => newText);
  return { path: target.relative, bytes: replaceFile(target, next), replacements: count };
}

/** Lines containing `query` (literal, case-sensitive) below `raw`, capped. */
export function searchFolder(root, raw, query, options = {}) {
  const target = projectTarget(root, raw, options);
  if (!target.exists) throw missing();
  const guarded = (options.protectedRoots || []).map((r) => {
    try {
      return fs.realpathSync.native(r);
    } catch {
      return r;
    }
  });
  const matches = [];
  let files = 0,
    bytes = 0,
    truncated = false;
  const queue = [target.real];
  while (queue.length && !truncated) {
    const folder = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(folder, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        if (!skipped.has(fold(entry.name)) && !guarded.includes(full)) queue.push(full);
        continue;
      }
      // Links are never followed: their targets may lie outside the folder.
      if (!entry.isFile()) continue;
      if (++files > fileLimits.searchFiles || bytes > fileLimits.searchBytes) {
        truncated = true;
        break;
      }
      let text;
      try {
        ({ text } = readText(full));
        bytes += text.length;
      } catch {
        continue;
      }
      if (!text.includes(query)) continue;
      const relative = path.relative(target.root, full).split(path.sep).join("/");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++)
        if (lines[i].includes(query)) {
          if (matches.length >= fileLimits.searchMatches) {
            truncated = true;
            break;
          }
          matches.push({
            path: relative,
            line: i + 1,
            text: lines[i].slice(0, fileLimits.lineChars),
          });
        }
      if (truncated) break;
    }
  }
  return { matches, truncated };
}
