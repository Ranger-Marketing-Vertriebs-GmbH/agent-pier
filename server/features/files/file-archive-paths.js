import { fileProblem } from "./file-errors.js";
import { validateFileName } from "./file-paths.js";

export function archivePath(name, { maxDepth = 128 } = {}) {
  if (
    typeof name !== "string" ||
    !name.isWellFormed() ||
    !name ||
    /[\\\0]/u.test(name) ||
    name.startsWith("/") ||
    /^[a-z]:/i.test(name) ||
    Buffer.byteLength(name) > 65535
  )
    throw fileProblem("FILE_INVALID_PATH", 400);
  const parts = name.replace(/\/$/, "").split("/");
  if (parts.length > maxDepth) throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
  for (const part of parts) validateFileName(part);
  return name;
}
export function archiveOutputLimit(payload, names) {
  if (!Number.isSafeInteger(payload) || payload < 0)
    throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
  let result = 2n * BigInt(payload) + 256n;
  for (const name of names) result += 2n * BigInt(Buffer.byteLength(name)) + 256n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER))
    throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
  return Number(result);
}
export function validateArchiveOperation(op) {
  if (
    !op.sources.length ||
    Object.keys(op.options).some((key) => key !== "output") ||
    !["file", "download"].includes(op.options.output)
  )
    return false;
  if (op.name !== null) {
    if (!op.name.isWellFormed()) return false;
    validateFileName(op.name);
  }
  return op.options.output === "download"
    ? op.target === null
    : typeof op.target === "string" && typeof op.name === "string";
}

export function validateZipEntry(entry, { seen, limits }) {
  const invalid = () => {
    throw fileProblem("FILE_ARCHIVE_PATH_INVALID", 400);
  };
  try {
    archivePath(entry.fileName, limits);
  } catch (error) {
    if (error.code === "FILE_LIMIT_EXCEEDED") throw error;
    invalid();
  }
  const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
  const directory = entry.fileName.endsWith("/");
  if (
    entry.generalPurposeBitFlag & ~0x80e ||
    ![0, directory ? 0x4000 : 0x8000].includes(mode) ||
    (!directory && entry.externalFileAttributes & 0x10) ||
    ![undefined, 0, 8].includes(entry.compressionMethod)
  )
    throw fileProblem("FILE_ARCHIVE_INVALID", 400);
  const size = entry.uncompressedSize;
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > limits.uploadBytes ||
    size > limits.jobBytes ||
    (directory && size !== 0)
  )
    throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
  const relative = entry.fileName.replace(/\/$/, ""),
    parts = relative.split("/");
  for (let index = 1; index <= parts.length; index++) {
    const name = parts.slice(0, index).join("/"),
      leaf = index === parts.length;
    const type = !leaf || directory ? "directory" : "file";
    const prior = seen.get(name);
    if (prior && (prior.type !== type || (leaf && prior.explicit))) invalid();
    if (!prior) {
      if (seen.size >= limits.jobEntries) throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
      seen.set(name, { relative: name, type, size: leaf ? size : 0, explicit: leaf });
    } else if (leaf) prior.explicit = true;
  }
  return { relative, type: directory ? "directory" : "file", size };
}
