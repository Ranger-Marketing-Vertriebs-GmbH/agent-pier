import { fileProblem } from "./file-errors.js";

const publicKinds = new Set([
  "create_file",
  "create_directory",
  "rename",
  "copy",
  "move",
  "trash",
  "restore",
  "purge",
  "archive",
  "extract",
  "search",
  "size",
]);
const metadata = new WeakMap();
export function createFileJobHandlers() {
  return new Map();
}

/** Private registration; public handlers must supply a kind-specific option validator. */
export function registerFileJobHandler(
  handlers,
  kind,
  handler,
  {
    transfer = false,
    readOnly = ["search", "size"].includes(kind),
    public: exposed = false,
    validate,
  } = {},
) {
  if (
    typeof handler !== "function" ||
    (exposed && (!publicKinds.has(kind) || typeof validate !== "function"))
  )
    throw new TypeError("Public file handlers require an allowed kind and validator.");
  const registered = (...args) => handler(...args);
  metadata.set(
    registered,
    Object.freeze({ transfer, readOnly, public: exposed, validate }),
  );
  handlers.set(kind, registered);
  return registered;
}
export function handlerPolicy(handler, kind) {
  return (
    metadata.get(handler) || {
      transfer: false,
      readOnly: ["search", "size"].includes(kind),
      public: false,
    }
  );
}
export function validateOperation(operation) {
  if (
    !operation ||
    typeof operation !== "object" ||
    Array.isArray(operation) ||
    typeof operation.kind !== "string" ||
    !operation.kind ||
    operation.kind.length > 64 ||
    !Array.isArray(operation.sources) ||
    operation.sources.length > 50000 ||
    operation.sources.some(
      (s) => typeof s !== "string" || s.length > 4096 || s.includes("\0"),
    ) ||
    ![operation.target, operation.name].every(
      (s) =>
        s === null || (typeof s === "string" && s.length <= 4096 && !s.includes("\0")),
    ) ||
    !operation.options ||
    typeof operation.options !== "object" ||
    Array.isArray(operation.options) ||
    Object.keys(operation).some(
      (k) =>
        ![
          "requestId",
          "kind",
          "sources",
          "target",
          "name",
          "options",
          "parentJobId",
          "entryId",
        ].includes(k),
    )
  )
    throw fileProblem("FILE_INVALID_OPERATION", 400);
  if (Buffer.byteLength(JSON.stringify(operation)) > 64 * 1024)
    throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
}

// These projections deliberately drop recovery paths, file contents and diagnostics.
export function safeIssue(issue) {
  return issue
    ? {
        code: /^FILE_[A-Z0-9_]+$/.test(issue.code || "") ? issue.code : "FILE_IO_ERROR",
        args:
          ["FILE_SEARCH_INCOMPLETE", "FILE_SIZE_INCOMPLETE"].includes(issue.code) &&
          [
            "entries",
            "results",
            "time",
            "depth",
            "overflow",
            "access",
            "changed",
            "io",
          ].includes(issue.args?.reason)
            ? { reason: issue.args.reason }
            : {},
      }
    : null;
}
export function projectConflict(info) {
  if (!info) return null;
  const result = {};
  for (const key of [
    "id",
    "type",
    "path",
    "source",
    "target",
    "revision",
    "manifestVersion",
  ])
    if (typeof info[key] === "string" && info[key].length <= 4096)
      result[key] = info[key];
  for (const key of ["sourceRevision", "targetRevision"])
    if (
      info[key] === null ||
      (typeof info[key] === "string" && /^e1:[a-f0-9]{64}$/.test(info[key]))
    )
      result[key] = info[key];
  if (info.source === null) result.source = null;
  if (Array.isArray(info.choices))
    result.choices = info.choices
      .filter((v) => typeof v === "string" && /^[a-z_]{1,40}$/.test(v))
      .slice(0, 20);
  return result;
}
export function progressPatch(patch, limits, kind) {
  const metadataJob = ["search", "size"].includes(kind);
  const entryLimit = metadataJob ? limits.searchEntries : limits.jobEntries;
  const byteLimit = metadataJob ? Number.MAX_SAFE_INTEGER : limits.jobBytes;
  const result = {};
  for (const key of [
    "completedEntries",
    "totalEntries",
    "completedBytes",
    "totalBytes",
  ]) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (value === null && key.startsWith("total")) {
      result[key] = null;
      continue;
    }
    if (
      !Number.isSafeInteger(value) ||
      value < 0 ||
      value > (key.endsWith("Entries") ? entryLimit : byteLimit)
    )
      throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
    result[key] = value;
  }
  if (Object.hasOwn(patch, "issue")) result.issue = safeIssue(patch.issue);
  return result;
}
export function projectEntry(entry) {
  const result = {};
  for (const key of ["id", "path", "relativePath", "name", "type", "status", "revision"])
    if (typeof entry[key] === "string") result[key] = entry[key].slice(0, 4096);
  for (const key of ["bytes", "size", "completedBytes"])
    if (Number.isSafeInteger(entry[key]) && entry[key] >= 0) result[key] = entry[key];
  // Typed rows expose unknown metadata explicitly, without inventing permission bits.
  if (["file", "directory", "symlink", "special"].includes(entry.type)) {
    result.size = Number.isSafeInteger(entry.size) && entry.size >= 0 ? entry.size : null;
    for (const key of ["revision", "modifiedAt", "linkTarget"])
      result[key] =
        typeof entry[key] === "string" && entry[key].length <= 4096 ? entry[key] : null;
    if (Number.isInteger(entry.mode) && entry.mode >= 0 && entry.mode <= 0o7777)
      result.mode = entry.mode;
    for (const key of ["readable", "writable"])
      result[key] = typeof entry[key] === "boolean" ? entry[key] : null;
  }
  if (entry.issue) result.issue = safeIssue(entry.issue);
  return result;
}
