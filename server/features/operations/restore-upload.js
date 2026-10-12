import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { problem } from "../../lib/storage.js";
import { atomic, identifier, readJson } from "./files.js";
import { decodeArchive } from "./archive.js";
import { archiveVersion, readArchiveHeader } from "./archive-v2.js";
import { ensureSpace } from "./backup-components.js";

/**
 * Restore uploads. A browser sends an archive in slices of at most CHUNK_LIMIT
 * bytes, each a short request appended at an exact offset, so no request comes
 * near the server's request timeout and an interrupted upload resumes where the
 * server's copy ends. Only a complete archive with a valid format header is kept as
 * `<id>.apbackup`; inspection and restore verify every member.
 */
export const CHUNK_LIMIT = 64 * 1024 * 1024;
const messages = serverMessages.backups;

async function validateUpload(file) {
  if ((await archiveVersion(file)) === 1) decodeArchive(file);
  else await readArchiveHeader(file);
}
/** Passes exactly `length` bytes; more, or fewer at the end, fail the stream. */
function exactly(length) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      seen += chunk.length;
      if (seen > length) callback(problem(messages.uploadLengthMismatch));
      else callback(null, chunk);
    },
    flush(callback) {
      callback(seen === length ? null : problem(messages.uploadLengthMismatch));
    },
  });
}
const sizeValue = (value) => {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw problem(messages.uploadLengthRequired, 411);
  return value;
};

export class RestoreUploads {
  constructor(directory) {
    this.directory = directory;
    this.busy = new Set();
  }
  /** Interrupted uploads from an earlier run are removed. */
  static clean(directory) {
    for (const name of fs.readdirSync(directory))
      if (name.endsWith(".upload") || name.endsWith(".upload.json"))
        fs.rmSync(path.join(directory, name), { force: true });
  }
  files(id) {
    const base = path.join(this.directory, `${identifier(id)}.apbackup`);
    return { data: `${base}.upload`, meta: `${base}.upload.json`, archive: base };
  }
  record(id) {
    const files = this.files(id);
    const meta = readJson(files.meta, null);
    if (!meta || !fs.existsSync(files.data))
      throw problem(serverMessages.operations.uploadNotFound, 404);
    return { ...files, size: meta.size, offset: fs.statSync(files.data).size };
  }
  /** Starts an upload of `size` bytes after checking free space for it. */
  begin(size) {
    sizeValue(size);
    ensureSpace(this.directory, size);
    const uploadId = randomUUID(),
      files = this.files(uploadId);
    fs.writeFileSync(files.data, "", { mode: 0o600, flag: "wx" });
    atomic(files.meta, { size, createdAt: new Date().toISOString() });
    return { uploadId, size, offset: 0, chunkLimit: CHUNK_LIMIT };
  }
  status(id) {
    const { size, offset } = this.record(id);
    return { uploadId: id, size, offset, chunkLimit: CHUNK_LIMIT };
  }
  /** Appends one slice of `length` bytes that starts at `offset`. */
  async append(id, offset, source, length) {
    const upload = this.record(id);
    sizeValue(length);
    if (
      !Number.isSafeInteger(offset) ||
      length > CHUNK_LIMIT ||
      offset + length > upload.size
    )
      throw problem(messages.invalidUploadChunk);
    if (this.busy.has(id)) throw problem(messages.uploadBusy, 409);
    if (offset !== upload.offset) throw problem(messages.uploadOffsetMismatch, 409);
    this.busy.add(id);
    try {
      ensureSpace(this.directory, length);
      await pipeline(
        source,
        exactly(length),
        fs.createWriteStream(upload.data, { flags: "r+", start: offset }),
      );
    } catch (error) {
      // A slice that did not arrive whole is cut off again; the client resends it.
      fs.truncateSync(upload.data, offset);
      throw error;
    } finally {
      this.busy.delete(id);
    }
    return this.status(id);
  }
  /** Checks a complete upload and keeps it as an archive for inspection. */
  async complete(id) {
    const upload = this.record(id);
    if (this.busy.has(id)) throw problem(messages.uploadBusy, 409);
    if (upload.offset !== upload.size) throw problem(messages.uploadIncomplete, 409);
    try {
      await validateUpload(upload.data);
      fs.renameSync(upload.data, upload.archive);
      return { archiveId: id };
    } finally {
      fs.rmSync(upload.data, { force: true });
      fs.rmSync(upload.meta, { force: true });
    }
  }
  abort(id) {
    const upload = this.record(id);
    if (this.busy.has(id)) throw problem(messages.uploadBusy, 409);
    fs.rmSync(upload.data, { force: true });
    fs.rmSync(upload.meta, { force: true });
  }
  /** One-request upload of bytes or a stream of exactly `expectedBytes`. */
  async single(source, { expectedBytes } = {}) {
    const length = Buffer.isBuffer(source) ? source.length : sizeValue(expectedBytes);
    ensureSpace(this.directory, length);
    const archiveId = randomUUID();
    const { data, archive } = this.files(archiveId);
    try {
      if (Buffer.isBuffer(source))
        fs.writeFileSync(data, source, { mode: 0o600, flag: "wx" });
      else
        await pipeline(
          source,
          exactly(length),
          fs.createWriteStream(data, { mode: 0o600, flags: "wx" }),
        );
      await validateUpload(data);
      fs.renameSync(data, archive);
      return { archiveId };
    } finally {
      fs.rmSync(data, { force: true });
    }
  }
}
