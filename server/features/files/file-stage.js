import path from "node:path";
import { createHash } from "node:crypto";
import { fileProblem } from "./file-errors.js";
import { entryRevision } from "./file-paths.js";
import { nativeReadBytes } from "./file-native.js";

export const inodeIdentity = (stat) => (stat ? `${stat.dev}:${stat.ino}` : null);
export const contentIdentity = (stat) =>
  JSON.stringify(
    ["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs"].map((key) =>
      String(stat[key]),
    ),
  );
export const sameInode = (stat, identity) => inodeIdentity(stat) === identity;

export async function inspect(native, directory, name) {
  try {
    return await native.run("inspect", { directory, name });
  } catch (error) {
    if (error.code === "FILE_NOT_FOUND") return null;
    throw error;
  }
}

/** Owner-local facade; no OS fd, no Node FileHandle construction. Writes are
 * serialized, backpressured 64KiB requests and bounded by the native safe-integer position bound. */
export function ownedHandle(native, opened) {
  let closed = false,
    tail = Promise.resolve(),
    position = 0;
  function enqueue(action) {
    if (closed) return Promise.reject(fileProblem("FILE_JOBS_CLOSED", 503));
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result;
  }
  return Object.freeze({
    native,
    handle: opened.handle,
    stat: () => enqueue(() => native.run("stat", { handle: opened.handle })),
    sync: () => enqueue(() => native.run("sync", { handle: opened.handle })),
    read: (buffer, offset, length, at) =>
      enqueue(async () => {
        const bytes = await native.run("read", {
          handle: opened.handle,
          length,
          position: at,
        });
        buffer.set(bytes, offset);
        return { bytesRead: bytes.length, buffer };
      }),
    writeFile: (value) => {
      const bytes = Buffer.from(value);
      return enqueue(async () => {
        for (let offset = 0; offset < bytes.length;) {
          const chunk = bytes.subarray(offset, offset + nativeReadBytes);
          const written = await native.run("write", {
            handle: opened.handle,
            bytes: chunk,
            position,
          });
          if (written < 1) throw fileProblem("FILE_IO_ERROR", 500);
          offset += written;
          position += written;
        }
      });
    },
    close: () => {
      if (!closed) {
        closed = true;
        tail = tail.then(() => native.run("closeHandle", { handle: opened.handle }));
      }
      return tail;
    },
  });
}

/** Public d1 includes the complete e1 observation and streamed content hash.
 * The separately named private token tolerates only exchange's ctime change;
 * publishers still validate parent, inode and selected-link identities separately. */
export async function publicationSnapshot(handle, linkIdentity = null) {
  const before = await handle.stat({ bigint: true });
  if (before.type ? before.type !== "file" : !before.isFile())
    throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
  if (before.size > BigInt(Number.MAX_SAFE_INTEGER))
    throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(nativeReadBytes);
  for (let position = 0; position < Number(before.size);) {
    const length = Math.min(buffer.length, Number(before.size) - position);
    const { bytesRead } = await handle.read(buffer, 0, length, position);
    if (!bytesRead) throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (entryRevision(before) !== entryRevision(await handle.stat({ bigint: true })))
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
  const bytes = hash.digest("hex");
  const fingerprint = (observation) =>
    createHash("sha256")
      .update(JSON.stringify([observation, bytes]))
      .digest("hex");
  return {
    revision: `d1:${fingerprint(entryRevision(before, linkIdentity))}`,
    publicationContentRevision: `p1:${fingerprint(contentIdentity(before))}`,
  };
}

export async function fileRevision(handle, linkIdentity = null) {
  return (await publicationSnapshot(handle, linkIdentity)).revision;
}

export async function openParent(native, absolute) {
  return ownedHandle(
    native,
    await native.run("openRoot", { path: path.dirname(absolute) }),
  );
}

export async function parentMatches(native, absolute, expected) {
  const parent = await openParent(native, absolute);
  try {
    return sameInode(await parent.stat(), expected);
  } finally {
    await parent.close();
  }
}

export async function closeStage(state) {
  const handles = [state.handle, state.parentHandle, state.targetParentHandle].filter(
    Boolean,
  );
  const outcomes = await Promise.allSettled(handles.map((handle) => handle.close()));
  const failed = outcomes.find((item) => item.status === "rejected");
  if (failed) throw failed.reason;
}

// Cleanup uses a retained parent and immediate prechecks, not a filesystem CAS.
export async function removeStageDirectory(native, state) {
  if (!(await parentMatches(native, state.target, state.document.targetParent)))
    throw fileProblem("FILE_PATH_CHANGED", 409);
  await native.run("removeEntry", {
    directory: state.targetParentHandle.handle,
    name: state.directoryName,
    identity: state.document.stageParent,
    type: "directory",
  });
  await state.targetParentHandle.sync();
}
