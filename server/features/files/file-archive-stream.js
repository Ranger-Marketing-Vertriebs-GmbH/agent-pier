import path from "node:path";
import { createHash } from "node:crypto";
import { Readable, Writable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import yazl from "yazl";
import { FileNative, nativeReadBytes } from "./file-native.js";
import { resolveFile, entryRevision } from "./file-paths.js";
import { ownedHandle, closeHandles, inodeIdentity } from "./file-stage.js";
import { fileProblem } from "./file-errors.js";

export async function openCheckedArchiveStream(
  scope,
  source,
  revision,
  signal,
  { native: supplied, charge = async () => {} } = {},
) {
  const native = supplied || new FileNative();
  let root, handle;
  const close = async () => {
    try {
      await closeHandles(handle, root);
    } finally {
      if (!supplied) await native.close();
    }
  };
  try {
    signal.throwIfAborted();
    const selected = await resolveFile(scope, source, { followLeaf: false });
    if (!selected.stat.isFile() || entryRevision(selected.stat) !== revision)
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    signal.throwIfAborted();
    const base = scope.kind === "project" ? scope.root : "/";
    root = ownedHandle(native, await native.run("openRoot", { path: base }));
    signal.throwIfAborted();
    handle = ownedHandle(
      native,
      await native.run("openFile", {
        directory: root.handle,
        path: path.relative(base, selected.absolute),
      }),
    );
    signal.throwIfAborted();
    const stat = await handle.stat();
    if (
      stat.type !== "file" ||
      entryRevision(stat) !== revision ||
      inodeIdentity(stat) !== inodeIdentity(selected.stat) ||
      stat.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    signal.throwIfAborted();
    let position = 0,
      reading = Promise.resolve(),
      busy = false;
    const stream = new Readable({
      highWaterMark: nativeReadBytes,
      read() {
        if (busy) return;
        busy = true;
        reading = (async () => {
          signal.throwIfAborted();
          if (position === Number(stat.size)) {
            const extra = Buffer.alloc(1);
            if (
              (await handle.read(extra, 0, 1, position)).bytesRead ||
              entryRevision(await handle.stat()) !== revision
            )
              throw fileProblem("FILE_CONFLICT_CHANGED", 409);
            this.push(null);
            return;
          }
          const buffer = Buffer.alloc(
            Math.min(nativeReadBytes, Number(stat.size) - position),
          );
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (!bytesRead || entryRevision(await handle.stat()) !== revision)
            throw fileProblem("FILE_CONFLICT_CHANGED", 409);
          signal.throwIfAborted();
          await charge(bytesRead);
          position += bytesRead;
          busy = false;
          this.push(buffer.subarray(0, bytesRead));
        })();
        reading.catch((error) => this.destroy(error));
      },
      destroy(error, callback) {
        reading
          .catch(() => {})
          .then(close)
          .then(
            () => callback(error),
            (failure) => callback(error || failure),
          );
      },
    });
    const abort = () => stream.destroy(signal.reason);
    stream.on("error", () => {});
    signal.addEventListener("abort", abort, { once: true });
    stream.once("close", () => signal.removeEventListener("abort", abort));
    return stream;
  } catch (error) {
    await close();
    throw error;
  }
}

export async function writeArchive(owner, context, plan, stage) {
  const { scope, signal, report } = context;
  const controller = new AbortController(),
    combined = AbortSignal.any([signal, controller.signal]);
  const zip = new yazl.ZipFile(),
    hash = createHash("sha256");
  const inputs = new Set(),
    opening = new Set(),
    draining = new Set();
  let failure,
    payload = 0,
    outputBytes = 0,
    writing = Promise.resolve();
  const output = new Writable({
    highWaterMark: nativeReadBytes,
    write(chunk, encoding, callback) {
      writing = (async () => {
        for (let offset = 0; offset < chunk.length; offset += nativeReadBytes) {
          combined.throwIfAborted();
          const bytes = chunk.subarray(offset, offset + nativeReadBytes);
          if (outputBytes + bytes.length > plan.outputLimit)
            throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
          await stage.handle.writeFile(bytes);
          hash.update(bytes);
          outputBytes += bytes.length;
          await owner.publisher.checkpointArchive(stage);
        }
      })();
      writing.then(() => callback(), callback);
    },
    destroy(error, callback) {
      writing.then(
        () => callback(error),
        () => callback(error),
      );
    },
  });
  const fail = (error) => {
    failure ||= error;
    controller.abort(error);
    for (const input of inputs) input.destroy(error);
    zip.outputStream.destroy(error);
    output.destroy(error);
  };
  const abort = () => fail(signal.reason);
  zip.on("error", fail);
  output.on("error", fail);
  zip.outputStream.on("error", fail);
  signal.addEventListener("abort", abort, { once: true });
  const pumping = pipeline(zip.outputStream, output, { signal: combined });
  pumping.catch(fail);
  try {
    signal.throwIfAborted();
    for (const row of plan.rows) {
      if (row.omitted) continue;
      const options = {
        mtime: new Date(0),
        mode: row.type === "directory" ? 0o40700 : 0o100600,
      };
      if (row.type === "directory") zip.addEmptyDirectory(row.memberName, options);
      else
        zip.addReadStreamLazy(
          row.memberName,
          { ...options, size: row.size, forceZip64Format: true },
          (callback) => {
            const promise = openCheckedArchiveStream(
              scope,
              row.source,
              row.revision,
              combined,
              {
                native: owner.publisher.native,
                charge: async (bytes) => {
                  if (
                    !Number.isSafeInteger(payload + bytes) ||
                    payload + bytes > owner.limits.jobBytes ||
                    payload + bytes > plan.bytes
                  )
                    throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
                  payload += bytes;
                  await report({ completedBytes: payload });
                },
              },
            ).then(
              async (input) => {
                inputs.add(input);
                input.on("error", fail);
                const done = finished(input)
                  .catch(fail)
                  .finally(() => inputs.delete(input));
                draining.add(done);
                done.finally(() => draining.delete(done));
                if (combined.aborted) {
                  input.destroy(combined.reason);
                  callback(combined.reason);
                } else callback(null, input);
              },
              (error) => {
                fail(error);
                callback(error);
              },
            );
            opening.add(promise);
            promise.finally(() => opening.delete(promise)).catch(fail);
          },
        );
    }
    zip.end({ forceZip64Format: true });
    await pumping;
    await Promise.all([...opening]);
    await Promise.all([...draining]);
    if (failure) throw failure;
    if (payload !== plan.bytes) throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    await report({ completedBytes: payload });
    return { hash: hash.digest("hex"), bytes: outputBytes };
  } catch (error) {
    fail(error);
    throw failure || error;
  } finally {
    await pumping.catch(() => {});
    await Promise.allSettled([...opening]);
    await Promise.allSettled([...draining]);
    await writing.catch(() => {});
    signal.removeEventListener("abort", abort);
  }
}
