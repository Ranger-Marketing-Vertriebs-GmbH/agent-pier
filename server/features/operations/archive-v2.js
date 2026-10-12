import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip, crc32 } from "node:zlib";
import { problem } from "../../lib/storage.js";
import { folder, relativeName } from "./files.js";
import { assertNoConflicts } from "./archive.js";
import { componentProblem } from "./backup-components.js";
import {
  ByteSource,
  endOfArchive,
  fileHeader,
  nextEntry,
  padding,
  zeroPadding,
} from "./tar.js";

/**
 * Backup format version 2 (docs/backups.md): a gzip-compressed POSIX tar written
 * and read as a stream. Its first entry, `agentpier-backup.json`, lists every
 * following entry with size, SHA-256 and kind before any file data, so a reader
 * validates every path before it writes a byte. The passphrase capsule is the one
 * `credentials` entry; everything else is public.
 */
export const HEADER_NAME = "agentpier-backup.json";
export const CAPSULE_NAME = "credentials.json";
export const FORMAT_VERSION = 2;
export const SCHEMA_VERSION = 2;
const HEADER_LIMIT = 64 * 1024 * 1024;
const CAPSULE_LIMIT = 256 * 1024 * 1024;
const MEMBER_LIMIT = 1_000_000;
const CHUNK = 1024 * 1024;
const STORED_BLOCK = 65535;
const PLACEHOLDER = "0".repeat(64);
const memberKeys = ["kind", "mode", "path", "sha256", "size"];
const invalid = () => problem(serverMessages.backups.invalidArchive);
const mismatch = () => problem(serverMessages.backups.memberMismatch);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * A gzip member with stored (uncompressed) deflate blocks. Its length depends only
 * on the data length, so the header entry is first written with placeholder hashes
 * and later rewritten in place once every member's hash is known.
 */
function storedGzip(data) {
  const parts = [Buffer.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255])];
  for (let offset = 0; offset < data.length; offset += STORED_BLOCK) {
    const slice = data.subarray(offset, offset + STORED_BLOCK);
    const block = Buffer.alloc(5);
    block[0] = offset + STORED_BLOCK >= data.length ? 1 : 0;
    block.writeUInt16LE(slice.length, 1);
    block.writeUInt16LE(~slice.length & 0xffff, 3);
    parts.push(block, slice);
  }
  const trailer = Buffer.alloc(8);
  trailer.writeUInt32LE(crc32(data), 0);
  trailer.writeUInt32LE(data.length % 2 ** 32, 4);
  parts.push(trailer);
  return Buffer.concat(parts);
}
function headerMember(header, mtime) {
  const json = Buffer.from(JSON.stringify(header));
  return storedGzip(
    Buffer.concat([
      fileHeader(HEADER_NAME, json.length, mtime),
      json,
      padding(json.length),
    ]),
  );
}
async function* fileChunks(entry) {
  let handle;
  try {
    handle = await fsp.open(entry.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw componentProblem(error.code === "ENOENT" ? "changed" : "unreadable", entry);
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw componentProblem("unreadable", entry);
    let position = 0;
    while (position < entry.size) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK, entry.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      // A file that shrank since it was planned cannot fill its declared entry.
      if (!bytesRead) throw componentProblem("changed", entry);
      position += bytesRead;
      yield buffer.subarray(0, bytesRead);
    }
  } finally {
    await handle.close();
  }
}
async function* body(entries, listing, mtime) {
  for (const [index, entry] of entries.entries()) {
    yield fileHeader(entry.path, entry.size, mtime);
    if (entry.bytes) {
      listing[index].sha256 = sha256(entry.bytes);
      yield entry.bytes;
    } else {
      const hash = createHash("sha256");
      for await (const chunk of fileChunks(entry)) {
        hash.update(chunk);
        yield chunk;
      }
      listing[index].sha256 = hash.digest("hex");
    }
    yield padding(entry.size);
  }
  yield endOfArchive();
}
function entryOf(member) {
  const name = relativeName(member.path);
  if (name === HEADER_NAME || name === CAPSULE_NAME)
    throw problem(serverMessages.backups.invalidMember);
  const bytes =
    member.bytes ??
    (typeof member.content === "string" ? Buffer.from(member.content, "base64") : null);
  if (bytes) return { ...member, path: name, bytes, size: bytes.length };
  if (typeof member.file !== "string" || !Number.isSafeInteger(member.size))
    throw problem(serverMessages.backups.invalidMember);
  return { ...member, path: name };
}

/**
 * Streams `members` (`{ path, bytes | content(base64) | file + size, ... }`) and
 * the optional sealed `capsule` into the new file `file`. Returns its byte size.
 */
export async function writeArchive(file, { manifest, members, capsule, level = 1 }) {
  const entries = members.map(entryOf);
  if (capsule) {
    const bytes = Buffer.from(JSON.stringify(capsule));
    entries.unshift({
      path: CAPSULE_NAME,
      kind: "credentials",
      bytes,
      size: bytes.length,
    });
  }
  const names = new Set(entries.map((entry) => entry.path));
  if (names.size !== entries.length) throw problem(serverMessages.backups.invalidMember);
  assertNoConflicts(names);
  const listing = entries.map((entry) => ({
    path: entry.path,
    size: entry.size,
    sha256: PLACEHOLDER,
    mode: 0o600,
    kind: entry.kind === "credentials" ? "credentials" : "public",
  }));
  const header = () => ({
    format: "agentpier-backup",
    version: FORMAT_VERSION,
    manifest: { ...manifest, schemaVersion: SCHEMA_VERSION },
    members: listing,
  });
  const mtime = Math.floor(Date.parse(manifest.createdAt) / 1000) || 0;
  const reserved = headerMember(header(), mtime);
  await fsp.writeFile(file, reserved, { flag: "wx", mode: 0o600 });
  await pipeline(
    body(entries, listing, mtime),
    createGzip({ level, memLevel: 8 }),
    fs.createWriteStream(file, { flags: "r+", start: reserved.length }),
  );
  const final = headerMember(header(), mtime);
  if (final.length !== reserved.length) throw invalid();
  const handle = await fsp.open(file, "r+");
  try {
    await handle.write(final, 0, final.length, 0);
    await handle.sync();
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

/** Validates the first entry of a version 2 archive; throws for anything unexpected. */
export function validateHeader(header) {
  if (
    !header ||
    typeof header !== "object" ||
    header.format !== "agentpier-backup" ||
    header.version !== FORMAT_VERSION ||
    !header.manifest ||
    typeof header.manifest !== "object" ||
    Array.isArray(header.manifest) ||
    header.manifest.schemaVersion !== SCHEMA_VERSION
  )
    throw problem(serverMessages.backups.unsupportedFormat);
  const members = header.members;
  if (
    Object.keys(header).length !== 4 ||
    !Array.isArray(members) ||
    members.length > MEMBER_LIMIT
  )
    throw problem(serverMessages.backups.invalidMembers);
  const names = new Set();
  let total = 0;
  for (const [index, member] of members.entries()) {
    if (
      !member ||
      typeof member !== "object" ||
      Object.keys(member).sort().join() !== memberKeys.join() ||
      !Number.isSafeInteger(member.size) ||
      member.size < 0 ||
      typeof member.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(member.sha256) ||
      member.mode !== 0o600 ||
      !["public", "credentials"].includes(member.kind)
    )
      throw problem(serverMessages.backups.invalidMember);
    const name = relativeName(member.path);
    const capsule = member.kind === "credentials";
    if (
      names.has(name) ||
      name === HEADER_NAME ||
      capsule !== (name === CAPSULE_NAME) ||
      (capsule && (index !== 0 || member.size > CAPSULE_LIMIT))
    )
      throw problem(serverMessages.backups.invalidMember);
    names.add(name);
    total += member.size;
    if (!Number.isSafeInteger(total))
      throw problem(serverMessages.backups.invalidMembers);
  }
  assertNoConflicts(names);
  if (
    typeof header.manifest.withCredentials !== "boolean" ||
    header.manifest.withCredentials !== names.has(CAPSULE_NAME)
  )
    throw problem(serverMessages.backups.credentialManifestMismatch);
  return header;
}

function open(file) {
  const input = fs.createReadStream(file, { highWaterMark: CHUNK });
  const gunzip = createGunzip({ chunkSize: 256 * 1024 });
  input.on("error", (error) => gunzip.destroy(error));
  return { input, gunzip, source: new ByteSource(input.pipe(gunzip)) };
}
function close({ input, gunzip, source }) {
  source.close()?.catch?.(() => {});
  input.destroy();
  gunzip.destroy();
}
async function readHeader(source) {
  const first = await nextEntry(source);
  if (!first || first.name !== HEADER_NAME || first.size > HEADER_LIMIT) throw invalid();
  const bytes = await source.exact(first.size);
  await zeroPadding(source, first.size);
  let header;
  try {
    header = JSON.parse(bytes);
  } catch {
    throw invalid();
  }
  return validateHeader(header);
}

/** 1 for the original JSON archive, 2 for a tar archive; rejects anything else. */
export async function archiveVersion(file) {
  const stream = open(file);
  try {
    const first = await stream.source.exact(1);
    if (first[0] === 0x7b) return 1;
    stream.source.buffer = Buffer.concat([first, stream.source.buffer]);
    const entry = await nextEntry(stream.source);
    if (entry?.name !== HEADER_NAME) throw invalid();
    return FORMAT_VERSION;
  } finally {
    close(stream);
  }
}
/** The validated header of a version 2 archive without reading its members. */
export async function readArchiveHeader(file) {
  const stream = open(file);
  try {
    return await readHeader(stream.source);
  } finally {
    close(stream);
  }
}

/**
 * Reads a version 2 archive in one pass. `visit(member)` decides per member, in
 * archive order, where its bytes go: `{ file }` (a new file, never replaced),
 * `{ collect(bytes) }` (small members, after their hash matched) or nothing (the
 * member is only verified). Every member's size and SHA-256 is checked; a missing,
 * extra, renamed, truncated or altered entry fails the read.
 */
export async function readArchive(file, { visit = () => null } = {}) {
  const stream = open(file);
  const { source } = stream;
  try {
    const header = await readHeader(source);
    for (const member of header.members) {
      const entry = await nextEntry(source);
      if (!entry || entry.name !== member.path || entry.size !== member.size)
        throw mismatch();
      const sink = await visit(member);
      const hash = createHash("sha256"),
        parts = sink?.collect ? [] : null;
      let output;
      if (sink?.file) {
        folder(path.dirname(sink.file));
        output = await fsp.open(sink.file, "wx", 0o600);
      }
      try {
        for await (const chunk of source.chunks(member.size)) {
          hash.update(chunk);
          if (output) await output.write(chunk);
          else parts?.push(chunk);
        }
      } finally {
        await output?.close();
      }
      await zeroPadding(source, member.size);
      if (hash.digest("hex") !== member.sha256)
        throw problem(serverMessages.backups.checksumMismatch);
      if (parts) await sink.collect(Buffer.concat(parts));
    }
    if ((await nextEntry(source)) !== null) throw mismatch();
    await source.zeroTail(1024 * 1024);
    return header;
  } finally {
    close(stream);
  }
}
