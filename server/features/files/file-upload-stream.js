import { createHash } from "node:crypto";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { nativeReadBytes } from "./file-native.js";
import { fileProblem } from "./file-errors.js";

export async function receiveUploadBytes(owner, scope, id, readable, stage, signal) {
  const hash = createHash("sha256");
  let received = 0,
    writing = Promise.resolve();
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
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await pipeline(chunks(), counter, output, { signal });
  } finally {
    signal.removeEventListener("abort", abort);
  }
  if (received !== owner.journal.attempt(id).bytes)
    throw fileProblem("FILE_UPLOAD_LENGTH", 400);
  await owner.publisher.checkpointUpload(stage, hash.digest("hex"));
}
