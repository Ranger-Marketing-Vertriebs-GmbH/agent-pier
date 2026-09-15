import path from "node:path";
import { Readable } from "node:stream";
import yauzl from "yauzl";
import { resolveFile, entryRevision } from "./file-paths.js";
import { openParent, ownedHandle, inodeIdentity, closeHandles } from "./file-stage.js";
import { nativeReadBytes } from "./file-native.js";
import { fileProblem } from "./file-errors.js";
import { validateZipEntry } from "./file-archive-paths.js";

const utf8 = new TextDecoder("utf-8", { fatal: true });
async function validateHeader(zip, entry) {
  if (entry.generalPurposeBitFlag & 0x800) utf8.decode(entry.fileNameRaw);
  for (const extra of entry.extraFields)
    if (extra.id === 0x7075 && extra.data.length >= 5 && extra.data[0] === 1)
      utf8.decode(extra.data.subarray(5));
  const local = await zip.readLocalFileHeaderPromise(entry);
  if (
    !local.fileName.equals(entry.fileNameRaw) ||
    local.generalPurposeBitFlag !== entry.generalPurposeBitFlag ||
    local.compressionMethod !== entry.compressionMethod
  )
    throw fileProblem("FILE_ARCHIVE_INVALID", 400);
}

const changed = () => fileProblem("FILE_CONFLICT_CHANGED", 409);
export async function openExtractSource(native, scope, source, signal, limits) {
  let parent, handle, reader, zip;
  try {
    signal.throwIfAborted();
    const selected = await resolveFile(scope, source, { followLeaf: false });
    if (!selected.stat.isFile()) throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    const revision = entryRevision(selected.stat);
    parent = await openParent(native, selected.absolute);
    handle = ownedHandle(
      native,
      await native.run("openFile", {
        directory: parent.handle,
        path: path.basename(selected.absolute),
      }),
    );
    const stat = await handle.stat();
    if (
      inodeIdentity(stat) !== inodeIdentity(selected.stat) ||
      entryRevision(stat) !== revision ||
      stat.size > BigInt(Number.MAX_SAFE_INTEGER)
    )
      throw changed();
    reader = new OwnedZipReader(handle, signal, Number(stat.size));
    zip = await new Promise((resolve, reject) =>
      yauzl.fromRandomAccessReader(
        reader,
        Number(stat.size),
        {
          lazyEntries: true,
          validateEntrySizes: true,
          strictFileNames: true,
          autoClose: false,
        },
        (error, opened) => (error ? reject(error) : resolve(opened)),
      ),
    );
    zip.on("error", () => {});
    const seen = new Map(),
      entries = new Map();
    let bytes = 0;
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      await validateHeader(zip, entry);
      const row = validateZipEntry(entry, { seen, limits });
      bytes += row.size;
      if (!Number.isSafeInteger(bytes) || bytes > limits.jobBytes)
        throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
      // Keep only fields consumed by openReadStream; discard comments/extra buffers.
      const kept = Object.create(Object.getPrototypeOf(entry));
      for (const key of [
        "fileName",
        "generalPurposeBitFlag",
        "compressionMethod",
        "compressedSize",
        "uncompressedSize",
        "relativeOffsetOfLocalHeader",
        "crc32",
      ])
        kept[key] = entry[key];
      entries.set(row.relative, kept);
    }
    const assertUnchanged = async () => {
      signal.throwIfAborted();
      const current = await resolveFile(scope, source, { followLeaf: false });
      if (
        current.absolute !== selected.absolute ||
        current.linkIdentity !== selected.linkIdentity ||
        entryRevision(current.stat) !== revision ||
        entryRevision(await handle.stat()) !== revision
      )
        throw changed();
    };
    await assertUnchanged();
    return {
      rows: [...seen.values()],
      entries,
      bytes,
      selected,
      revision,
      assertUnchanged,
      stream: (entry) =>
        new Promise((resolve, reject) =>
          zip.openReadStream(entry, (error, stream) =>
            error ? reject(error) : resolve(stream),
          ),
        ),
      close: async () => {
        zip.close();
        await reader.dispose();
        await closeHandles(handle, parent);
      },
    };
  } catch (error) {
    zip?.close();
    await reader?.dispose();
    await closeHandles(handle, parent);
    if (error.code?.startsWith("FILE_") || signal.aborted) throw error;
    throw fileProblem("FILE_ARCHIVE_INVALID", 400);
  }
}

class OwnedZipReader extends yauzl.RandomAccessReader {
  constructor(handle, signal, size) {
    super();
    Object.assign(this, { handle, signal, size, pending: new Set(), streams: new Set() });
    this.on("error", () => {});
    this.abort = () => {
      for (const stream of this.streams) stream.destroy(signal.reason);
    };
    signal.addEventListener("abort", this.abort, { once: true });
  }
  async range(buffer, offset, length, position) {
    if (!Number.isSafeInteger(position) || position < 0 || position + length > this.size)
      throw fileProblem("FILE_ARCHIVE_INVALID", 400);
    for (let count = 0; count < length;) {
      this.signal.throwIfAborted();
      const { bytesRead } = await this.handle.read(
        buffer,
        offset + count,
        Math.min(nativeReadBytes, length - count),
        position + count,
      );
      if (!bytesRead) throw changed();
      count += bytesRead;
    }
    this.signal.throwIfAborted();
  }
  read(buffer, offset, length, position, callback) {
    const work = this.range(buffer, offset, length, position);
    this.pending.add(work);
    work.then(
      () => {
        this.pending.delete(work);
        callback(null);
      },
      (error) => {
        this.pending.delete(work);
        callback(error);
      },
    );
  }
  _readStreamForRange(start, end) {
    const owner = this;
    const stream = Readable.from(
      (async function* () {
        for (let position = start; position < end;) {
          const bytes = Buffer.alloc(Math.min(nativeReadBytes, end - position));
          const work = owner.range(bytes, 0, bytes.length, position);
          owner.pending.add(work);
          try {
            await work;
          } finally {
            owner.pending.delete(work);
          }
          position += bytes.length;
          yield bytes;
        }
      })(),
      { objectMode: false, highWaterMark: nativeReadBytes },
    );
    this.streams.add(stream);
    stream.on("error", () => {});
    stream.once("close", () => this.streams.delete(stream));
    return stream;
  }
  close(callback) {
    this.dispose().then(() => callback(null), callback);
  }
  dispose() {
    return (this.closing ||= (async () => {
      this.signal.removeEventListener("abort", this.abort);
      const streams = [...this.streams];
      const closed = streams.map((stream) =>
        stream.closed
          ? Promise.resolve()
          : new Promise((resolve) => stream.once("close", resolve)),
      );
      for (const stream of streams) stream.destroy();
      await Promise.allSettled([...this.pending, ...closed]);
    })());
  }
}
