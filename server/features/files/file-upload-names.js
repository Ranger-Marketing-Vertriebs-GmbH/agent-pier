import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { validateFileName } from "./file-paths.js";
import { fileProblem } from "./file-errors.js";
import { uploadNfd } from "./file-upload-normalize.js";

export const uploadNamePolicy = "unicode-15.1-cf-nfd-v1";
const folds = new Map();
const data = readFileSync(
  new URL("./unicode-15.1/CaseFolding.txt", import.meta.url),
  "utf8",
);
for (const line of data.split("\n")) {
  const [point, status, mapping] = line.split(";").map((part) => part.trim());
  if (["C", "F"].includes(status))
    folds.set(
      Number.parseInt(point, 16),
      String.fromCodePoint(
        ...mapping.split(" ").map((value) => Number.parseInt(value, 16)),
      ),
    );
}
// Versioned product rejection rule, not an assertion of target filesystem equivalence.
export function uploadNameKey(name) {
  return uploadNfd(
    Array.from(uploadNfd(name), (point) => folds.get(point.codePointAt(0)) ?? point).join(
      "",
    ),
  );
}
export function uploadRelativePath(value, limits) {
  if (
    typeof value !== "string" ||
    !value ||
    !value.isWellFormed() ||
    Buffer.byteLength(value) > 4096
  )
    throw fileProblem("FILE_INVALID_PATH", 400);
  const parts = value.split("/");
  if (parts.length > limits.maxDepth) throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
  parts.forEach(validateFileName);
  return parts;
}
export function uploadId(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    /\p{Cc}/u.test(value) ||
    !value.isWellFormed()
  )
    throw fileProblem("FILE_INVALID_REQUEST", 400);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export function uploadHash(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}
