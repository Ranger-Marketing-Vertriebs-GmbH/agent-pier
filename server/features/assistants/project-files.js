import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { assistantProblem } from "./assistant-validation.js";
import { projectTarget } from "./project-paths.js";
import { openInside, openInsideSync } from "./project-open.js";
import { fold } from "./team-plugin/tool-guard.js";
import {
  INLINE_IMAGE_TYPES,
  MAX_INLINE_IMAGE_BYTES,
  detectAttachment,
} from "./agent-attachment-types.js";

// What one tool call reads, lists, searches or writes at most. A write comes through
// the bridge, whose request limit (128 KiB, JSON-escaped) bounds it further.
export const fileLimits = {
  readBytes: 1048576,
  readChars: 200000,
  readLines: 2000,
  // A line range of a larger file: how far one call scans for it.
  scanBytes: 268435456,
  sniffBytes: 8192,
  listEntries: 1000,
  searchFiles: 5000,
  searchMatches: 200,
  // Every byte search reads counts, sniffed or in full.
  searchBytes: 33554432,
  lineChars: 300,
  writeBytes: 65536,
  // An appended file stays editable and searchable in one piece.
  appendTotalBytes: 16777216,
};
// Never descended into by search: dependencies and the runs' own checkouts.
const skipped = new Set([".git", "node_modules", ".agentpier-worktrees"].map(fold));
const unsuitable = () => assistantProblem("projectFileUnsuitable", 400);
const missing = () => assistantProblem("notFound", 404);
const strict = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
// O_NONBLOCK: a FIFO or device opens at once and is refused by its type.
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NONBLOCK } = fs.constants;
const readFlags = O_RDONLY | O_NONBLOCK;

// A regular file with a single link; a second hard link could be a file outside
// the folder, and no symbolic link is followed on the way (openInside), not even a
// parent folder swapped for one after the path was checked.
async function openRegular(file) {
  let handle;
  try {
    handle = await openInside(file, readFlags);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") throw missing();
    throw unsuitable();
  }
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink > 1) {
    await handle.close();
    throw unsuitable();
  }
  return { handle, stat };
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (!bytesRead) break;
    read += bytesRead;
  }
  return buffer.subarray(0, read);
}

const sniff = (handle, stat) =>
  readAt(handle, 0, Math.min(fileLimits.sniffBytes, stat.size));

// The bytes of a text file below the read limit: binary content is refused after
// sniffing its start, before the rest is read.
async function readBytes(file, limit = fileLimits.readBytes) {
  const { handle, stat } = await openRegular(file);
  try {
    if (stat.size > limit) throw unsuitable();
    const head = await sniff(handle, stat);
    if (head.includes(0)) throw unsuitable();
    const rest = await readAt(handle, head.length, stat.size - head.length);
    return Buffer.concat([head, rest]);
  } finally {
    await handle.close();
  }
}

// Changing a file needs exact UTF-8: anything else would be rewritten with
// replacement characters.
function decodeStrict(bytes) {
  try {
    return strict.decode(bytes);
  } catch {
    throw assistantProblem("projectFileEncoding", 400);
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

// Lines `start` .. `start + limit - 1` of a large file, read in chunks: lines before
// the range are skipped without being kept, each kept line is capped, and the scan
// stops at the output or scan limit. The total line count stays unknown.
async function lineRange(handle, size, start, limit) {
  const lines = [];
  let line = 1,
    chars = 0,
    current = [],
    kept = 0,
    position = 0;
  const finish = () => {
    lines.push(Buffer.concat(current).toString("utf8"));
    chars += lines.at(-1).length + 1;
    current = [];
    kept = 0;
  };
  while (position < size && position < fileLimits.scanBytes) {
    const chunk = await readAt(handle, position, Math.min(65536, size - position));
    if (!chunk.length) break;
    let from = 0;
    for (;;) {
      const newline = chunk.indexOf(10, from);
      const end = newline === -1 ? chunk.length : newline;
      if (line >= start && kept < fileLimits.readChars) {
        const part = chunk.subarray(
          from,
          Math.min(end, from + fileLimits.readChars - kept),
        );
        current.push(part);
        kept += part.length;
      }
      if (newline === -1) break;
      if (line >= start) finish();
      line++;
      from = newline + 1;
      if (lines.length >= limit || chars > fileLimits.readChars)
        return { lines, more: position + from < size };
    }
    position += chunk.length;
  }
  if (position < size) return { lines, more: true };
  // The end of the file closes its last (possibly empty) line.
  if (line >= start) finish();
  return { lines, more: false };
}

/**
 * Text of one file, by 1-based line `offset` and line `limit`. Files up to 1 MiB are
 * read whole; larger ones by line range (totalLines null). Reading is lenient about
 * encoding; binary files are refused.
 */
export async function readFile(
  root,
  raw,
  { offset = 1, limit = fileLimits.readLines, ...options } = {},
) {
  const target = projectTarget(root, raw, options);
  if (!target.exists) throw missing();
  const start = Math.max(1, offset);
  const count = Math.min(limit, fileLimits.readLines);
  const { handle, stat } = await openRegular(target.real);
  try {
    const head = await sniff(handle, stat);
    if (head.includes(0)) throw unsuitable();
    if (stat.size > fileLimits.readBytes) {
      const range = await lineRange(handle, stat.size, start, count);
      let content = range.lines.join("\n");
      const cut = content.length > fileLimits.readChars;
      if (cut) content = content.slice(0, fileLimits.readChars);
      return {
        path: target.relative,
        content,
        offset: start,
        totalLines: null,
        truncated: cut || range.more,
      };
    }
    const rest = await readAt(handle, head.length, stat.size - head.length);
    const lines = Buffer.concat([head, rest]).toString("utf8").split("\n");
    let content = lines.slice(start - 1, start - 1 + count).join("\n");
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
  } finally {
    await handle.close();
  }
}

/**
 * One image of the folder for the model (image_view): a PNG, JPEG, GIF or WebP file,
 * recognized by its bytes like an uploaded chat image, up to the inline image limit
 * the runtime accepts. The path is resolved like every read.
 */
export async function viewImage(root, raw, options = {}) {
  const target = projectTarget(root, raw, options);
  if (!target.exists) throw missing();
  const { handle, stat } = await openRegular(target.real);
  let bytes;
  try {
    if (!stat.size || stat.size > MAX_INLINE_IMAGE_BYTES)
      throw assistantProblem("projectImageUnsuitable", 400);
    bytes = await readAt(handle, 0, stat.size);
  } finally {
    await handle.close();
  }
  const detected = detectAttachment(bytes, path.basename(target.real));
  if (detected?.kind !== "image" || !INLINE_IMAGE_TYPES.has(detected.type))
    throw assistantProblem("projectImageUnsuitable", 400);
  return {
    path: target.relative,
    mimeType: detected.type,
    bytes: bytes.length,
    data: bytes.toString("base64"),
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

/*
 * Replaces the file through a temporary sibling and a rename; an existing file keeps
 * its mode. projectTarget already resolved every link that leads somewhere, so an
 * existing link inside the folder is written at its real target. Only a dangling
 * link remains at the final name, and the rename replaces that link itself instead
 * of creating its target. The temporary file is created without following any link
 * (openInsideSync), so its data never lands outside the folder. The rename and the
 * folder creation stay path-based (Node has no renameat): a process that can change
 * the folder could still swap a folder for a link during them.
 */
function replaceFile(target, data) {
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
  let fd;
  try {
    fd = openInsideSync(temporary, O_WRONLY | O_CREAT | O_EXCL, mode);
  } catch (error) {
    throw error.code === "ELOOP" ? unsuitable() : error;
  }
  try {
    fs.fchmodSync(fd, mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(temporary, target.real);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  return Buffer.byteLength(data);
}

function writable(content) {
  const bytes = Buffer.byteLength(content);
  if (bytes > fileLimits.writeBytes) throw assistantProblem("projectWriteTooLarge", 400);
  return bytes;
}

/** Creates or replaces one file with `content` (at most 64 KiB). */
export function writeFile(root, raw, content, options = {}) {
  writable(content);
  const target = projectTarget(root, raw, { ...options, write: true });
  if (!target.relative) throw unsuitable();
  const created = !target.exists;
  if (target.exists && !fs.lstatSync(target.real).isFile()) throw unsuitable();
  return { path: target.relative, bytes: replaceFile(target, content), created };
}

/**
 * Adds `content` (at most 64 KiB) to the end of a UTF-8 file, creating it when
 * missing; the file stays within the append limit.
 */
export async function appendFile(root, raw, content, options = {}) {
  const bytes = writable(content);
  const target = projectTarget(root, raw, { ...options, write: true });
  if (!target.relative) throw unsuitable();
  let existing = Buffer.alloc(0);
  if (target.exists) {
    existing = await readBytes(target.real, fileLimits.appendTotalBytes);
    decodeStrict(existing);
  }
  if (existing.length + bytes > fileLimits.appendTotalBytes) throw unsuitable();
  const size = replaceFile(target, Buffer.concat([existing, Buffer.from(content)]));
  return { path: target.relative, bytes, size, created: !target.exists };
}

/** Replaces `oldText` (exactly once, or every time with `replaceAll`) by `newText`. */
export async function editFile(
  root,
  raw,
  { oldText, newText, replaceAll = false },
  options = {},
) {
  const target = projectTarget(root, raw, { ...options, write: true });
  if (!target.exists) throw missing();
  const text = decodeStrict(await readBytes(target.real));
  const count = oldText ? text.split(oldText).length - 1 : 0;
  if (!count || (count > 1 && !replaceAll))
    throw assistantProblem("projectEditNoMatch", 409);
  const next = replaceAll
    ? text.split(oldText).join(newText)
    : text.replace(oldText, () => newText);
  return { path: target.relative, bytes: replaceFile(target, next), replacements: count };
}

// One file's text for search, or null; every byte read counts toward `scanned`.
async function searchable(file, scanned) {
  let opened;
  try {
    opened = await openRegular(file);
  } catch {
    return null;
  }
  const { handle, stat } = opened;
  try {
    const head = await sniff(handle, stat);
    scanned.bytes += head.length;
    if (head.includes(0) || stat.size > fileLimits.readBytes) return null;
    const rest = await readAt(handle, head.length, stat.size - head.length);
    scanned.bytes += rest.length;
    return Buffer.concat([head, rest]).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

/** Lines containing `query` (literal, case-sensitive) below `raw`, capped. */
export async function searchFolder(root, raw, query, options = {}) {
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
  const scanned = { bytes: 0 };
  let files = 0,
    truncated = false;
  const queue = [target.real];
  while (queue.length && !truncated) {
    const folder = queue.shift();
    let entries;
    try {
      entries = await fs.promises.readdir(folder, { withFileTypes: true });
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
      if (++files > fileLimits.searchFiles || scanned.bytes > fileLimits.searchBytes) {
        truncated = true;
        break;
      }
      const text = await searchable(full, scanned);
      if (text === null || !text.includes(query)) continue;
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
  return { matches, truncated, scannedBytes: scanned.bytes };
}
