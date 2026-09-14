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
