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
import { claim } from "./work-claims.js";

/**
 * Restore uploads. A browser sends an archive in slices of at most CHUNK_LIMIT
 * bytes, each a short request appended at an exact offset, so no request comes
 * near the server's request timeout and an interrupted upload resumes where the
 * server's copy ends, also after a server restart. Only a complete archive with a
 * valid format header is kept as `<id>.apbackup`; inspection and restore verify
 * every member. A successful restore removes it; one left unused expires like an
 * idle upload.
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

// An upload without a new slice, or an archive unused, for this long is abandoned
// and removed.
export const UPLOAD_TTL = 24 * 60 * 60 * 1000;

export class RestoreUploads {
  constructor(directory, dataDir, { ttl = UPLOAD_TTL } = {}) {
    this.directory = directory;
    this.dataDir = dataDir;
    this.ttl = ttl;
    this.busy = new Set();
    this.releases = new Map();
    // Archives an inspection or restore reads: id -> number of readers.
    this.readers = new Map();
  }
  /** Pending uploads: `{ id, data, meta, size, offset, idle }`. */
  pending() {
    const result = [];
    for (const name of fs.readdirSync(this.directory)) {
      const match = /^([A-Za-z0-9_-]+)\.apbackup\.upload\.json$/.exec(name);
      if (!match) continue;
      const files = this.files(match[1]);
      const meta = readJson(files.meta, null);
      const stat = fs.statSync(files.data, { throwIfNoEntry: false });
      if (!meta || !stat) continue;
      result.push({
        id: match[1],
        ...files,
        size: meta.size,
        offset: stat.size,
        idle: Date.now() - Math.max(stat.mtimeMs, Date.parse(meta.createdAt) || 0),
      });
    }
    return result;
  }
  /** Uploaded archives: `{ id, file, idle }`. */
  archives() {
    const result = [];
    for (const name of fs.readdirSync(this.directory)) {
      const match = /^([A-Za-z0-9_-]+)\.apbackup$/.exec(name);
      const file = path.join(this.directory, name);
      const stat = match && fs.statSync(file, { throwIfNoEntry: false });
      if (stat?.isFile())
        result.push({ id: match[1], file, idle: Date.now() - stat.mtimeMs });
    }
    return result;
  }
  /**
   * Removes uploads and archives idle beyond the TTL; returns the bytes the
   * remaining uploads still need.
   */
  sweep(except) {
    for (const archive of this.archives())
      if (archive.idle > this.ttl && !this.readers.has(archive.id))
        fs.rmSync(archive.file, { force: true });
    let reserved = 0;
    for (const upload of this.pending()) {
      if (upload.id === except || this.busy.has(upload.id)) {
        if (upload.id !== except) reserved += upload.size - upload.offset;
        continue;
      }
      if (upload.idle > this.ttl) this.remove(upload.id);
      else reserved += upload.size - upload.offset;
    }
    return reserved;
  }
  remove(id) {
    const files = this.files(id);
    fs.rmSync(files.data, { force: true });
    fs.rmSync(files.meta, { force: true });
    this.releases.get(id)?.();
    this.releases.delete(id);
  }
  /**
   * Marks the uploaded archive `id` as read until the returned release is called;
   * its idle time starts again. Returns null when there is no such archive.
   */
  read(id) {
    const { archive } = this.files(id);
    const now = new Date();
    try {
      fs.utimesSync(archive, now, now);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    this.readers.set(id, (this.readers.get(id) || 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = this.readers.get(id) - 1;
      if (left) this.readers.set(id, left);
      else this.readers.delete(id);
    };
  }
  /** Removes the uploaded archive `id` once it has been restored. */
  discard(id) {
    fs.rmSync(this.files(id).archive, { force: true });
  }
  files(id) {
    const base = path.join(this.directory, `${identifier(id)}.apbackup`);
    return { data: `${base}.upload`, meta: `${base}.upload.json`, archive: base };
  }
  record(id) {
    this.sweep(id);
    const files = this.files(id);
    const meta = readJson(files.meta, null);
    if (!meta || !fs.existsSync(files.data))
      throw problem(serverMessages.operations.uploadNotFound, 404);
    return { ...files, size: meta.size, offset: fs.statSync(files.data).size };
  }
  /** Starts an upload of `size` bytes after checking free space for it. */
  begin(size) {
    sizeValue(size);
    // Uploads still in progress keep the room they announced.
    ensureSpace(this.directory, size + this.sweep());
    const uploadId = randomUUID(),
      files = this.files(uploadId);
    this.releases.set(uploadId, claim(this.dataDir, files.data));
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
      ensureSpace(this.directory, length + this.sweep(id));
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
    // A second completion (or a slice) waits for this one to finish.
    this.busy.add(id);
    try {
      await validateUpload(upload.data);
      fs.renameSync(upload.data, upload.archive);
      // An archive expires a TTL after it was completed (or last read).
      const now = new Date();
      fs.utimesSync(upload.archive, now, now);
      return { archiveId: id };
    } finally {
      this.remove(id);
      this.busy.delete(id);
    }
  }
  abort(id) {
    this.record(id);
    if (this.busy.has(id)) throw problem(messages.uploadBusy, 409);
    this.remove(id);
  }
  /** One-request upload of bytes or a stream of exactly `expectedBytes`. */
  async single(source, { expectedBytes } = {}) {
    const length = Buffer.isBuffer(source) ? source.length : sizeValue(expectedBytes);
    ensureSpace(this.directory, length + this.sweep());
    const archiveId = randomUUID();
    const { data, archive } = this.files(archiveId);
    const release = claim(this.dataDir, data);
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
      const now = new Date();
      fs.utimesSync(archive, now, now);
      return { archiveId };
    } finally {
      fs.rmSync(data, { force: true });
      release();
    }
  }
}
