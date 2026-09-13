import fs from "node:fs/promises";
import path from "node:path";
import { problem } from "../../lib/storage.js";
import { createDirectory } from "../../lib/directories.js";
import { filesCopy as copy } from "../../lib/i18n/de/files.js";
import { previewResolvedFile } from "./file-reading.js";

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

export async function previewProjectFile(rootPath, relative) {
  const resolved = await resolve(rootPath, relative);
  try {
    return await previewResolvedFile(
      { absolute: resolved.target, path: resolved.relative },
      { legacy: true },
    );
  } catch (error) {
    if (error.code === "FILE_LIMIT_EXCEEDED") throw problem(copy.tooLarge, 413);
    if (error.code === "FILE_UNSUPPORTED_TYPE") throw problem(copy.binary, 415);
    throw problem(copy.unavailable, 404);
  }
}

export async function createProjectDirectory(rootPath, relative, name) {
  const resolved = await resolve(rootPath, relative);
  const result = await createDirectory(resolved.target, name);
  return { path: path.relative(resolved.root, result.path).split(path.sep).join("/") };
}
