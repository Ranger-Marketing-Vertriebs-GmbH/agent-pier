import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { FileNative, nativeReadBytes } from "./file-native.js";
import { resolveFile, entryRevision } from "./file-paths.js";
import { ownedHandle, closeHandles, inodeIdentity } from "./file-stage.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";

export async function downloadFile(scope, selectedPath, response, { signal } = {}) {
  let native, root, handle;
  try {
    signal?.throwIfAborted();
    const selected = await resolveFile(scope, selectedPath);
    if (!selected.stat.isFile()) throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    const base = scope.kind === "project" ? scope.root : "/";
    native = new FileNative();
    root = ownedHandle(native, await native.run("openRoot", { path: base }));
    handle = ownedHandle(
      native,
      await native.run("openFile", {
        directory: root.handle,
        path: path.relative(base, selected.absolute),
      }),
    );
    const stat = await handle.stat();
    if (
      stat.type !== "file" ||
      inodeIdentity(stat) !== inodeIdentity(selected.stat) ||
      entryRevision(stat) !== entryRevision(selected.stat)
    )
      throw fileProblem("FILE_PATH_CHANGED", 409);
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
    attachmentHeaders(response, selected.path, stat.size);
    await pipeline(Readable.from(ownedDownloadBytes(handle, stat, signal)), response, {
      signal,
    });
  } catch (error) {
    throw fileSystemProblem(error);
  } finally {
    try {
      await closeHandles(handle, root);
    } finally {
      await native?.close();
    }
  }
}

export function attachmentHeaders(response, selectedName, size) {
  const name = path.basename(selectedName).replace(/[\p{Cc}]/gu, "_");
  const fallback = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(name).replace(
    /['()*]/g,
    (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  response.setHeader("Content-Type", "application/octet-stream");
  response.setHeader(
    "Content-Disposition",
    `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`,
  );
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("Content-Length", String(size));
}
export async function* ownedDownloadBytes(handle, stat, signal) {
  const buffer = Buffer.alloc(nativeReadBytes);
  for (let position = 0; position < Number(stat.size);) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, Number(stat.size) - position),
      position,
    );
    if (!bytesRead) throw fileProblem("FILE_PATH_CHANGED", 409);
    position += bytesRead;
    yield Buffer.from(buffer.subarray(0, bytesRead));
  }
  if (entryRevision(await handle.stat()) !== entryRevision(stat))
    throw fileProblem("FILE_PATH_CHANGED", 409);
}
