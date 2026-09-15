import { createHash } from "node:crypto";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nativeReadBytes } from "./file-native.js";
import { fileProblem } from "./file-errors.js";

export async function receiveUploadBytes(
  owner,
  scope,
  id,
  readable,
  stage,
  signal,
  onInputFailure,
) {
  const hash = createHash("sha256");
  let received = 0,
    writing = Promise.resolve(),
    failure;
  async function* chunks() {
    for await (const value of readable.iterator({ destroyOnReturn: false })) {
      signal.throwIfAborted();
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      for (let offset = 0; offset < bytes.length; offset += nativeReadBytes)
        yield bytes.subarray(offset, offset + nativeReadBytes);
    }
  }
  const counter = new Transform({
    highWaterMark: nativeReadBytes,
    transform(chunk, encoding, callback) {
      owner.barrier
        .run(() => owner.journal.charge(scope, id, chunk.length))
        .then((count) => {
          received = count;
          hash.update(chunk);
          callback(null, chunk);
        }, callback);
    },
  });
  const output = new Writable({
    highWaterMark: nativeReadBytes,
    write(chunk, encoding, callback) {
      writing = (async () => {
        await stage.handle.writeFile(chunk);
        await owner.publisher.checkpointUpload(stage);
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
  const abort = () => readable.destroy();
  const fail = (error) => {
    if (!signal.aborted && !failure) {
      failure = error;
      // The HTTP boundary must detach transport cancellation before destroying
      // IncomingMessage emits aborted/close for this established server failure.
      onInputFailure?.();
    }
    abort();
  };
  // Pipeline cannot finish an async iterator's pending original read until the
  // readable is stopped. Downstream errors must do this without client input.
  counter.on("error", fail);
  output.on("error", fail);
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await pipeline(chunks(), counter, output, { signal });
  } catch (error) {
    throw failure || error;
  } finally {
    signal.removeEventListener("abort", abort);
    counter.removeListener("error", fail);
    output.removeListener("error", fail);
  }
  if (received !== owner.journal.attempt(id).bytes)
    throw fileProblem("FILE_UPLOAD_LENGTH", 400);
  await owner.publisher.checkpointUpload(stage, hash.digest("hex"));
}
