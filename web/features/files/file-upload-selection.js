import { fileClientIssue } from "./file-api.js";

const utf8 = (text) => new TextEncoder().encode(text).length;
const invalid = (code = "FILE_INVALID_PATH") => fileClientIssue(code, 400);
export function uploadPathParts(path, maxDepth = 128) {
  if (typeof path !== "string" || !path || !path.isWellFormed() || utf8(path) > 4096)
    throw invalid();
  const parts = path.split("/");
  if (parts.length > maxDepth) throw invalid("FILE_LIMIT_EXCEEDED");
  if (
    parts.some(
      (part) =>
        !part || part === "." || part === ".." || /[\\\0]/.test(part) || utf8(part) > 255,
    )
  )
    throw invalid();
  return parts;
}

/** Snapshot browser entry/File references before the first asynchronous traversal. */
export async function collectUploadSelection(
  input,
  { maxEntries = 50000, maxDepth = 128, signal } = {},
) {
  const read = (work) =>
    new Promise((resolve, reject) => {
      const abort = () => finish(reject, new DOMException("Aborted", "AbortError"));
      const finish = (callback, value) => {
        signal?.removeEventListener("abort", abort);
        callback(value);
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        work(
          (value) => finish(resolve, value),
          (error) => finish(reject, error),
        );
      } catch (error) {
        finish(reject, error);
      }
    });
  const roots = [];
  const fallback = [];
  let incomplete = Boolean(input?.webkitdirectory);
  if (input?.items) {
    for (const item of Array.from(input.items)) {
      if (item.kind !== "file") continue;
      const entry = item.webkitGetAsEntry?.();
      if (entry) roots.push(entry);
      else {
        const file = item.getAsFile?.();
        if (file) fallback.push(file);
        incomplete = true;
      }
    }
  } else if (
    input?.webkitdirectory &&
    Array.from(input.webkitEntries || []).some((entry) => entry.isDirectory)
  )
    roots.push(...input.webkitEntries);
  else fallback.push(...Array.from(input?.files ?? input ?? []));
  const files = [],
    directories = [],
    entries = new Map(),
    explicit = new Set();
  const register = (relativePath, type, declared = false) => {
    const parts = uploadPathParts(relativePath, maxDepth);
    for (let count = 1; count <= parts.length; count++) {
      const path = parts.slice(0, count).join("/");
      const leaf = count === parts.length;
      const value = leaf ? type : "directory";
      if (entries.has(path)) {
        if (
          entries.get(path) !== "directory" ||
          value !== "directory" ||
          (leaf && declared && explicit.has(path))
        )
          throw invalid("FILE_UPLOAD_ALIAS");
      } else {
        entries.set(path, value);
        if (entries.size > maxEntries) throw invalid("FILE_LIMIT_EXCEEDED");
        if (value === "directory") directories.push(path);
      }
      if (leaf && declared) explicit.add(path);
    }
  };
  const addFile = (file, relativePath) => {
    if (
      !file ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.slice !== "function"
    )
      throw invalid("FILE_INVALID_OPERATION");
    register(relativePath, "file", true);
    files.push({ file, relativePath });
  };
  const walk = async (entry, parent = "") => {
    uploadPathParts(entry.name, 1);
    const relativePath = parent ? `${parent}/${entry.name}` : entry.name;
    if (entry.isFile) {
      const file = await read((resolve, reject) => entry.file(resolve, reject));
      addFile(file, relativePath);
    } else if (entry.isDirectory) {
      register(relativePath, "directory", true);
      const reader = entry.createReader();
      for (;;) {
        const batch = await read((resolve, reject) =>
          reader.readEntries(resolve, reject),
        );
        if (!batch.length) break;
        for (const child of batch) await walk(child, relativePath);
      }
    } else throw invalid("FILE_INVALID_OPERATION");
  };
  for (const file of fallback) {
    incomplete ||= Boolean(file.webkitRelativePath);
    addFile(file, file.webkitRelativePath || file.name);
  }
  for (const root of roots) await walk(root);
  return { files, directories, omissions: incomplete ? ["emptyDirectories"] : [] };
}
