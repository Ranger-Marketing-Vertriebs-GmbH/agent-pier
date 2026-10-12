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
import { sealChunks, sealedSize } from "./history-seal.js";
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
const sealedName = /^sealed\/(?:0|[1-9]\d{0,8})$/;
const invalid = () => problem(serverMessages.backups.invalidArchive);
const mismatch = () => problem(serverMessages.backups.memberMismatch);

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
// Removed members and grown sizes change the header's length; it is padded with
// spaces (valid JSON whitespace) to the length reserved before the members streamed.
const SLACK_PER_FILE = 20;
const SLACK = 4096;
export const removedOmission = "Files removed while the backup was written";
export const changedOmission = "Files that changed while the backup was written";
/** The `consistency` of a capture entry naming a file that changed while read. */
export const CHANGED_DURING_READ = "changed-during-read";
// A changed path is recorded once more in the manifest's captures.
const CHANGED_ENTRY = JSON.stringify({
  component: "",
  consistency: CHANGED_DURING_READ,
}).length;
function headerMember(header, mtime, length) {
  const text = Buffer.from(JSON.stringify(header));
  if (length !== undefined && text.length > length) throw invalid();
  const json =
    length === undefined
      ? text
      : Buffer.concat([text, Buffer.alloc(length - text.length, 0x20)]);
  return storedGzip(
    Buffer.concat([
      fileHeader(HEADER_NAME, json.length, mtime),
      json,
      padding(json.length),
    ]),
  );
}
/**
 * Opens a planned file. It is read through this descriptor at its current size, so
 * a writer that replaces or deletes it afterwards no longer matters. A file that
 * is gone already yields null: it is left out and reported.
 */
async function openSource(entry) {
  let handle;
  try {
    handle = await fsp.open(entry.file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw componentProblem("unreadable", entry);
  }
  const stat = await handle.stat();
  if (!stat.isFile() || stat.nlink !== 1) {
    await handle.close();
    throw componentProblem("unreadable", entry);
  }
  return { handle, size: stat.size, stat };
}
/**
 * Whether a file was rewritten while it was read: it shrank, or its modification
 * or change time moved. Growth alone also moves them; restores keep line-based
 * members, whose archived prefix stays valid, and leave the others out.
 */
const changedWhileRead = (before, after, outcome) =>
  outcome.truncated ||
  after.size < before.size ||
  after.mtimeMs !== before.mtimeMs ||
  after.ctimeMs !== before.ctimeMs;
async function* fileChunks(source, size, outcome) {
  let position = 0;
  while (position < size) {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK, size - position));
    const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position);
    if (!bytesRead) {
      // Truncated in place while it was read: the entry's size is already written,
      // so it is filled with blank lines, which line-based histories skip.
      outcome.truncated = true;
      for (let left = size - position; left > 0; left -= CHUNK)
        yield Buffer.alloc(Math.min(left, CHUNK), 0x0a);
      return;
    }
    position += bytesRead;
    yield buffer.subarray(0, bytesRead);
  }
}
async function* body(entries, listing, mtime, report, opened) {
  for (const [index, entry] of entries.entries()) {
    let source = null,
      plain,
      size;
    const outcome = {};
    if (entry.bytes) {
      plain = [entry.bytes];
      size = entry.bytes.length;
    } else {
      source = await openSource(entry);
      if (!source) {
        listing[index] = null;
        report.removed.push(entry.path);
        continue;
      }
      await opened?.(entry);
      size = source.size;
      plain = fileChunks(source, size, outcome);
    }
    try {
      // Sealed history is archived as ciphertext of the plaintext read now.
      const archived = entry.seal ? sealedSize(size) : size;
      listing[index].size = archived;
      yield fileHeader(entry.path, archived, mtime);
      const hash = createHash("sha256");
      for await (const chunk of entry.seal
        ? sealChunks(plain, size, entry.seal)
        : plain) {
        hash.update(chunk);
        yield chunk;
      }
      if (source && changedWhileRead(source.stat, await source.handle.stat(), outcome))
        report.changed.push(entry.path);
      listing[index].sha256 = hash.digest("hex");
      yield padding(archived);
    } finally {
      await source?.handle.close();
      // Work copies (database snapshots) are removed once archived.
      if (entry.temporary) await fsp.rm(entry.file, { force: true });
    }
  }
  yield endOfArchive();
}
function entryOf(member) {
  // Sealed history appears in the archive under its opaque name only.
  const name = relativeName(member.seal ? member.name : member.path);
  if (member.seal ? !sealedName.test(name) : name.startsWith("sealed/"))
    throw problem(serverMessages.backups.invalidMember);
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
 * the optional sealed `capsule` into the new file `file`. Files are archived at
 * the size they have when they are read; files that disappeared before are left
 * out. Returns `{ bytes, manifest, removed, changed }`, `manifest` being the one
 * written, with an omission for each kind of change.
 */
export async function writeArchive(
  file,
  { manifest, members, capsule, level = 1, opened },
) {
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
    kind: entry.kind === "credentials" ? "credentials" : entry.seal ? "sealed" : "public",
  }));
  const report = { removed: [], changed: [] };
  const finalManifest = () => {
    const omissions = [...(manifest.omissions || [])];
    if (report.removed.length) omissions.push(removedOmission);
    if (report.changed.length) omissions.push(changedOmission);
    const changed = report.changed.map((name) => ({
      component: name,
      consistency: CHANGED_DURING_READ,
    }));
    return {
      ...manifest,
      schemaVersion: SCHEMA_VERSION,
      ...(manifest.omissions || omissions.length ? { omissions } : {}),
      ...(manifest.captures || changed.length
        ? { captures: [...(manifest.captures || []), ...changed] }
        : {}),
    };
  };
  const header = () => ({
    format: "agentpier-backup",
    version: FORMAT_VERSION,
    manifest: finalManifest(),
    members: listing.filter(Boolean),
  });
  const mtime = Math.floor(Date.parse(manifest.createdAt) / 1000) || 0;
  // Room for every streamed file to grow in size and to be recorded as changed.
  const streamed = entries
    .filter((entry) => !entry.bytes)
    .reduce(
      (sum, entry) =>
        sum +
        SLACK_PER_FILE +
        CHANGED_ENTRY +
        Buffer.byteLength(JSON.stringify(entry.path)),
      0,
    );
  const length =
    Buffer.byteLength(JSON.stringify(header())) +
    SLACK +
    streamed +
    removedOmission.length +
    changedOmission.length;
  const reserved = headerMember(header(), mtime, length);
  await fsp.writeFile(file, reserved, { flag: "wx", mode: 0o600 });
  await pipeline(
    body(entries, listing, mtime, report, opened),
    createGzip({ level, memLevel: 8 }),
    fs.createWriteStream(file, { flags: "r+", start: reserved.length }),
  );
  const written = header();
  const final = headerMember(written, mtime, length);
  const handle = await fsp.open(file, "r+");
  try {
    await handle.write(final, 0, final.length, 0);
    await handle.sync();
    return {
      bytes: (await handle.stat()).size,
      manifest: written.manifest,
      ...report,
    };
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
  let total = 0,
    sealed = 0;
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
      !["public", "credentials", "sealed"].includes(member.kind)
    )
      throw problem(serverMessages.backups.invalidMember);
    const name = relativeName(member.path);
    const capsule = member.kind === "credentials";
    if (member.kind === "sealed") sealed++;
    if (
      (member.kind === "sealed") !== sealedName.test(name) ||
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
    header.manifest.withCredentials !== names.has(CAPSULE_NAME) ||
    // Sealed history is opened with a key from the capsule only.
    (sealed && !names.has(CAPSULE_NAME))
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
    stream.source.unshift(first);
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
 * extra, renamed, truncated or altered entry fails the read. A sink with `unseal`
 * (history-seal.js Unsealer) receives the entry's opened plaintext. With `count`, only the
 * first `count` members are read and nothing after them is verified.
 */
export async function readArchive(file, { visit = () => null, count } = {}) {
  const stream = open(file);
  const { source } = stream;
  try {
    const header = await readHeader(source);
    // An inspection reads only the first `count` members.
    const partial = count !== undefined && count < header.members.length;
    for (const member of header.members.slice(0, count)) {
      const entry = await nextEntry(source);
      if (!entry || entry.name !== member.path || entry.size !== member.size)
        throw mismatch();
      const sink = await visit(member);
      const hash = createHash("sha256"),
        parts = sink?.collect ? [] : null;
      let output;
      if (sink?.file) {
        folder(path.dirname(sink.file));
        try {
          output = await fsp.open(sink.file, "wx", 0o600);
        } catch (error) {
          // Names unique in the archive can still collide on a file system that
          // ignores case or Unicode normalization.
          if (error.code === "EEXIST")
            throw problem(serverMessages.backups.caseConflict, 409);
          throw error;
        }
      }
      try {
        // A sealed entry is opened chunk by chunk; only authenticated bytes land.
        const unseal = sink?.unseal;
        const put = async (bytes) => {
          if (output) await output.write(bytes);
          else parts?.push(bytes);
        };
        for await (const chunk of source.chunks(member.size)) {
          hash.update(chunk);
          if (!unseal) await put(chunk);
          else for (const opened of unseal.update(chunk)) await put(opened);
        }
        await zeroPadding(source, member.size);
        if (hash.digest("hex") !== member.sha256)
          throw problem(serverMessages.backups.checksumMismatch);
        if (unseal) for (const opened of unseal.final()) await put(opened);
      } finally {
        await output?.close();
      }
      if (parts) await sink.collect(Buffer.concat(parts));
    }
    if (partial) return header;
    if ((await nextEntry(source)) !== null) throw mismatch();
    await source.zeroTail(1024 * 1024);
    return header;
  } finally {
    close(stream);
  }
}
