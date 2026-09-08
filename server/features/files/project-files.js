import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { problem } from "../../lib/storage.js";
import { createDirectory } from "../../lib/directories.js";
import { filesCopy as copy } from "../../lib/i18n/de/files.js";

const pageSize = 100;
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

async function resolve(rootPath, relative = "") {
  if (
    typeof relative !== "string" ||
    relative.length > 4096 ||
    relative.includes("\0") ||
    path.isAbsolute(relative) ||
    relative.split(/[\\/]/).includes("..")
  )
    throw problem(copy.outside, 403);
  try {
    const root = await fs.realpath(rootPath);
    const target = await fs.realpath(path.join(root, relative));
    if (!inside(root, target)) throw problem(copy.outside, 403);
    return {
      root,
      target,
      relative: path.relative(root, target).split(path.sep).join("/"),
    };
  } catch (error) {
    if (error.status === 403) throw error;
    throw problem(copy.unavailable, 404);
  }
}

export async function listProjectFiles(rootPath, relative, rawPage = "1") {
  if (!/^[1-9]\d{0,5}$/.test(String(rawPage))) throw problem(copy.invalidPage);
  const page = Number(rawPage);
  const resolved = await resolve(rootPath, relative);
  let entries;
  try {
    entries = await fs.readdir(resolved.target, { withFileTypes: true });
  } catch {
    throw problem(copy.unavailable, 404);
  }
  const sorted = entries
    .filter((entry) => entry.name !== ".git" && (entry.isDirectory() || entry.isFile()))
    .sort(
      (a, b) =>
        Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name),
    );
  const offset = (page - 1) * pageSize;
  return {
    path: resolved.relative,
    page,
    total: sorted.length,
    hasMore: offset + pageSize < sorted.length,
    entries: sorted.slice(offset, offset + pageSize).map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : "file",
      path: [resolved.relative, entry.name].filter(Boolean).join("/"),
    })),
  };
}

function imageMime(buffer) {
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

export async function previewProjectFile(rootPath, relative) {
  const resolved = await resolve(rootPath, relative);
  let handle;
  try {
    handle = await fs.open(
      resolved.target,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw problem(copy.unavailable, 404);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw problem(copy.notFile, 415);
    if (stat.size > 5 * 1024 * 1024) throw problem(copy.tooLarge, 413);
    // Read once into a bounded buffer; a growing file cannot exhaust server memory.
    const buffer = Buffer.alloc(Math.min(stat.size + 1, 5 * 1024 * 1024 + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const content = buffer.subarray(0, bytesRead);
    const mime = imageMime(content);
    if (mime)
      return {
        path: resolved.relative,
        type: "image",
        source: `data:${mime};base64,${content.toString("base64")}`,
      };
    if (bytesRead > 256 * 1024) throw problem(copy.tooLarge, 413);
    if (content.includes(0)) throw problem(copy.binary, 415);
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    } catch {
      throw problem(copy.binary, 415);
    }
    return { path: resolved.relative, type: "text", text };
  } finally {
    await handle.close();
  }
}

export async function createProjectDirectory(rootPath, relative, name) {
  const resolved = await resolve(rootPath, relative);
  const result = await createDirectory(resolved.target, name);
  return { path: path.relative(resolved.root, result.path).split(path.sep).join("/") };
}
