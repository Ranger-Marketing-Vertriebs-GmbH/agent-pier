import fs from "node:fs/promises";
import { constants } from "node:fs";
import { defaultFileLimits, readFileLimits } from "./file-limits.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";
import { entryRevision, resolveFile } from "./file-paths.js";

const legacyTextBytes = 256 * 1024;
const legacyImageBytes = 5 * 1024 * 1024;
const magicBytes = 12;

function entryType(stat) {
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  if (stat.isSymbolicLink()) return "symlink";
  return "special";
}

function publicSize(stat, type) {
  if (type !== "file" || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return Number(stat.size);
}

function modifiedAt(stat) {
  const milliseconds = stat.mtimeNs / 1_000_000n;
  if (milliseconds > BigInt(8.64e15) || milliseconds < BigInt(-8.64e15)) return null;
  return new Date(Number(milliseconds)).toISOString();
}

async function permissionHint(absolute, mode) {
  try {
    await fs.access(absolute, mode);
    return true;
  } catch (error) {
    if (["EACCES", "EPERM", "EROFS"].includes(error.code)) return false;
    throw error;
  }
}

/** Project an internal resolved entry without exposing BigIntStats. */
export async function projectFileEntry(scope, resolved) {
  try {
    const type = entryType(resolved.stat);
    const permissionsKnown = type === "file" || type === "directory";
    const linkTarget = type === "symlink" ? await fs.readlink(resolved.absolute) : null;
    return {
      path: resolved.path,
      name: resolved.name,
      type,
      size: publicSize(resolved.stat, type),
      modifiedAt: modifiedAt(resolved.stat),
      mode: Number(resolved.stat.mode & 0o7777n),
      readable: permissionsKnown
        ? await permissionHint(resolved.absolute, constants.R_OK)
        : null,
      writable: permissionsKnown
        ? !scope.readOnly && (await permissionHint(resolved.absolute, constants.W_OK))
        : null,
      linkTarget,
      revision: entryRevision(resolved.stat, resolved.linkIdentity),
    };
  } catch (error) {
    throw fileSystemProblem(error);
  }
}

export async function metadata(scope, path) {
  const resolved = await resolveFile(scope, path, { followLeaf: false });
  return projectFileEntry(scope, resolved);
}

export function imageMime(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    return "image/png";
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString())) return "image/gif";
  if (
    buffer.subarray(0, 4).toString() === "RIFF" &&
    buffer.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  return null;
}

async function fillBuffer(handle, buffer) {
  let used = 0;
  while (used < buffer.length) {
    const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
    if (!bytesRead) break;
    used += bytesRead;
  }
  return used;
}

async function readBounded(handle, limit) {
  const buffer = Buffer.alloc(limit + 1);
  const used = await fillBuffer(handle, buffer);
  if (used > limit) throw fileProblem("FILE_LIMIT_EXCEEDED", 413, { limit });
  return buffer.subarray(0, used);
}

/** Read an already resolved regular file through a bounded, no-follow descriptor. */
export async function previewResolvedFile(resolved, { legacy = false, limits } = {}) {
  let handle;
  try {
    handle = await fs.open(
      resolved.absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    const magic = Buffer.alloc(magicBytes);
    const magicUsed = await fillBuffer(handle, magic);
    const mime = imageMime(magic.subarray(0, magicUsed));
    const configured = limits ? readFileLimits(limits) : defaultFileLimits;
    const limit = mime
      ? legacy
        ? legacyImageBytes
        : configured.imageBytes
      : legacy
        ? legacyTextBytes
        : configured.textBytes;
    const content = await readBounded(handle, limit);
    if (mime)
      return {
        path: resolved.path,
        type: "image",
        source: `data:${mime};base64,${content.toString("base64")}`,
      };
    if (content.includes(0)) throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    }
    return { path: resolved.path, type: "text", text };
  } catch (error) {
    throw fileSystemProblem(error);
  } finally {
    if (handle) await handle.close();
  }
}

export async function preview(scope, path, options = {}) {
  const resolved = await resolveFile(scope, path);
  if (!resolved.stat.isFile()) throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
  return previewResolvedFile(resolved, options);
}
