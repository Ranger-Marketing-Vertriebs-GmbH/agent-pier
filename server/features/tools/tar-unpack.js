import { serverMessages } from "../../lib/i18n/de.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { problem } from "../../lib/storage.js";
import {
  assertLinksInside,
  checkLink,
  entryMode,
  entryName,
  realParents,
} from "./archive-safety.js";

// A streaming tar.gz unpacker for managed tools (Ghidra bottle, JDK, frida prebuild):
// the archive is read block by block, never held in memory, and every entry passes
// the same checks as the browser's zip archive.
const BLOCK = 512,
  MAX_META = 1024 * 1024,
  MAX_TRAILER = 1024 * 1024;
const bad = (message) => problem(message, 409);
const invalid = () => bad(serverMessages.tools.archiveInvalid);
const defaults = { maxExpanded: 2 * 1024 * 1024 * 1024, maxFiles: 30000 };
const padding = (size) => (BLOCK - (size % BLOCK)) % BLOCK;

function checkAbort(signal) {
  if (signal?.aborted) throw bad(serverMessages.tools.installationAbortedOrTimedOut);
}

// Exact reads over the gunzip stream; a short read means a truncated archive.
function reader(stream, signal) {
  const iterator = stream[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0);
  const pull = async () => {
    checkAbort(signal);
    let next;
    try {
      next = await iterator.next();
    } catch {
      checkAbort(signal);
      throw invalid();
    }
    if (next.done) return false;
    pending = pending.length ? Buffer.concat([pending, next.value]) : next.value;
    return true;
  };
  return {
    async read(size) {
      while (pending.length < size) if (!(await pull())) throw invalid();
      const data = pending.subarray(0, size);
      pending = pending.subarray(size);
      return data;
    },
    async *stream(size) {
      while (size > 0) {
        if (!pending.length && !(await pull())) throw invalid();
        const piece = pending.subarray(0, Math.min(size, pending.length));
        pending = pending.subarray(piece.length);
        size -= piece.length;
        yield piece;
      }
    },
    async skip(size) {
      for await (const piece of this.stream(size)) void piece;
    },
    // After the end block only zero padding may follow; reading to the end lets
    // gunzip check the archive's CRC.
    async drain() {
      let trailing = pending.length;
      if (pending.some((byte) => byte !== 0)) throw invalid();
      pending = Buffer.alloc(0);
      while (await pull()) {
        trailing += pending.length;
        if (trailing > MAX_TRAILER || pending.some((byte) => byte !== 0)) throw invalid();
        pending = Buffer.alloc(0);
      }
    },
  };
}

const text = (block, start, end) =>
  block.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");

function octal(block, start, end) {
  if (block[start] & 0x80) throw invalid();
  const value = text(block, start, end).trim();
  if (!/^[0-7]*$/.test(value)) throw invalid();
  const number = parseInt(value || "0", 8);
  if (!Number.isSafeInteger(number)) throw invalid();
  return number;
}

function checksum(block) {
  let unsigned = 0,
    signed = 0;
  for (let index = 0; index < BLOCK; index++) {
    const byte = index >= 148 && index < 156 ? 32 : block[index];
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  const stored = octal(block, 148, 156);
  if (stored !== unsigned && stored !== signed) throw invalid();
}

function paxFields(data) {
  const values = {};
  for (let offset = 0; offset < data.length;) {
    const space = data.indexOf(32, offset);
    if (space < 0 || space - offset > 8) throw invalid();
    const length = Number(data.toString("ascii", offset, space));
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset + 2 ||
      offset + length > data.length ||
      data[offset + length - 1] !== 10
    )
      throw invalid();
    const record = data.toString("utf8", space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (equals < 1) throw invalid();
    values[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  const result = {};
  if (values.path !== undefined) result.path = values.path;
  if (values.linkpath !== undefined) result.linkpath = values.linkpath;
  if (values.size !== undefined) {
    if (!/^\d{1,16}$/.test(values.size)) throw invalid();
    result.size = Number(values.size);
    if (!Number.isSafeInteger(result.size)) throw invalid();
  }
  return result;
}

const gnuName = (data) => data.toString("utf8").replace(/\0+$/, "");

/** Unpacks one regular file, folder or link below `dest` after the shared checks. */
async function unpackEntry(input, entry, state) {
  const { dest, top, limits, signal } = state;
  const directory = entry.type === "5";
  const name = directory && !entry.name.endsWith("/") ? `${entry.name}/` : entry.name;
  const relative = entryName(name, top);
  if (!directory && name.endsWith("/")) throw bad(serverMessages.tools.unsafeArchivePath);
  if (!["0", "\0", "5", "2", "1"].includes(entry.type))
    throw bad(serverMessages.tools.specialArchiveFilesForbidden);
  const regular = entry.type === "0" || entry.type === "\0";
  let source,
    size = regular ? entry.size : 0;
  if (entry.type === "1") {
    // A hard link becomes a copy of a regular file unpacked earlier below `top`.
    source = entryName(entry.link, top);
    if (!state.files.has(source)) throw bad(serverMessages.tools.unsafeArchivePath);
    size = state.files.get(source);
  }
  if (++state.count > limits.maxFiles || (state.expanded += size) > limits.maxExpanded)
    throw bad(serverMessages.tools.archiveSizeExceeded);
  const key = relative.toLowerCase();
  if (state.seen.has(key)) throw bad(serverMessages.tools.duplicateArchivePaths);
  state.seen.add(key);
  const target = path.join(dest, relative);
  await realParents(dest, relative);
  if (directory) {
    const stat = await fsp.lstat(target).catch(() => null);
    if (!stat) await fsp.mkdir(target, { mode: 0o755 });
    else if (!stat.isDirectory() || stat.isSymbolicLink())
      throw bad(serverMessages.tools.unsafeArchivePath);
  } else if (entry.type === "2") {
    checkLink(relative, entry.link, top);
    await fsp.symlink(entry.link, target);
    state.links.push(target);
  } else if (entry.type === "1") {
    await fsp.copyFile(path.join(dest, source), target, fs.constants.COPYFILE_EXCL);
  } else {
    await pipeline(
      Readable.from(input.stream(entry.size)),
      fs.createWriteStream(target, { flags: "wx", mode: entryMode(entry.mode) }),
      { signal },
    );
    // Set explicitly: the stored mode does not depend on the server's umask.
    await fsp.chmod(target, entryMode(entry.mode));
    state.files.set(relative, entry.size);
    return input.skip(padding(entry.size));
  }
  return input.skip(entry.size + padding(entry.size));
}

/**
 * Unpacks the tar.gz archive `file` into `dest`. Every entry lies below `top`; files,
 * folders, relative links inside `top` and hard links to earlier files are allowed.
 */
export async function unpackTarGz(file, dest, top, signal, limits = {}) {
  checkAbort(signal);
  const state = {
    dest,
    top,
    signal,
    limits: { ...defaults, ...limits },
    count: 0,
    expanded: 0,
    seen: new Set(),
    files: new Map(),
    links: [],
  };
  const gunzip = zlib.createGunzip();
  pipeline(fs.createReadStream(file), gunzip).catch(() => {});
  const input = reader(gunzip, signal);
  try {
    let meta = {},
      headers = 0;
    for (;;) {
      checkAbort(signal);
      const block = await input.read(BLOCK);
      if (block.every((byte) => byte === 0)) {
        if (Object.keys(meta).length) throw invalid();
        await input.drain();
        break;
      }
      if (++headers > state.limits.maxFiles * 4 + 16)
        throw bad(serverMessages.tools.archiveSizeExceeded);
      checksum(block);
      const type = String.fromCharCode(block[156]);
      const size = octal(block, 124, 136);
      if (["x", "g", "L", "K"].includes(type)) {
        if (size > MAX_META) throw invalid();
        const data = Buffer.from(await input.read(size + padding(size))).subarray(
          0,
          size,
        );
        if (type === "x") meta = { ...meta, ...paxFields(data) };
        else if (type === "L") meta.longName = gnuName(data);
        else if (type === "K") meta.longLink = gnuName(data);
        continue;
      }
      const prefix = text(block, 257, 263) === "ustar" ? text(block, 345, 500) : "";
      const entry = {
        type,
        name:
          meta.path ??
          meta.longName ??
          (prefix ? `${prefix}/` : "") + text(block, 0, 100),
        link: meta.linkpath ?? meta.longLink ?? text(block, 157, 257),
        size: meta.size ?? size,
        mode: octal(block, 100, 108),
      };
      meta = {};
      await unpackEntry(input, entry, state);
    }
    assertLinksInside(dest, top, state.links);
  } catch (cause) {
    if (cause?.status) throw cause;
    checkAbort(signal);
    if (["ENOSPC", "EDQUOT"].includes(cause?.code)) throw cause;
    throw invalid();
  } finally {
    gunzip.destroy();
  }
}
