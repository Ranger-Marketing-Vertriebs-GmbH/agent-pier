import { serverMessages } from "../../lib/i18n/de.js";
import { problem } from "../../lib/storage.js";

/**
 * The small subset of POSIX ustar that version 2 backups use: regular files with
 * mode 0600, a PAX `path` record for names that do not fit the 100-byte field, and
 * the two zero blocks that end an archive. The reader accepts nothing else.
 */
export const BLOCK = 512;
const ZERO_BLOCK = Buffer.alloc(BLOCK);
const MAGIC = Buffer.from("ustar\x0000", "latin1");
const OCTAL_SIZE_LIMIT = 8 ** 11;
const PAX_LIMIT = 64 * 1024;
const invalid = () => problem(serverMessages.backups.invalidArchive);

export const padding = (size) => Buffer.alloc((BLOCK - (size % BLOCK)) % BLOCK);
export const endOfArchive = () => Buffer.alloc(2 * BLOCK);

function octal(target, offset, length, value) {
  target.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, "latin1");
}
function header(name, size, type, mtime) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, 100, "utf8");
  octal(block, 100, 8, 0o600);
  octal(block, 108, 8, 0);
  octal(block, 116, 8, 0);
  if (size < OCTAL_SIZE_LIMIT) octal(block, 124, 12, size);
  else {
    // GNU base-256: the high bit marks a big-endian binary size.
    block[124] = 0x80;
    block.writeBigUInt64BE(BigInt(size), 128);
  }
  octal(block, 136, 12, mtime);
  block.fill(0x20, 148, 156);
  block.write(type, 156, 1, "latin1");
  MAGIC.copy(block, 257);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "latin1");
  return block;
}
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body);
  length += String(length).length;
  if (String(length).length + Buffer.byteLength(body) !== length) length++;
  return Buffer.from(`${length}${body}`, "utf8");
}
const fitsHeader = (name) => /^[\x20-\x7e]{1,100}$/.test(name);

/** The header blocks for a regular file `name` of `size` bytes. */
export function fileHeader(name, size, mtime = 0) {
  if (fitsHeader(name)) return header(name, size, "0", mtime);
  const record = paxRecord("path", name);
  return Buffer.concat([
    header("PaxHeader", record.length, "x", mtime),
    record,
    padding(record.length),
    header(name.replace(/[^\x20-\x7e]/g, "_").slice(-100), size, "0", mtime),
  ]);
}

function parseNumber(field) {
  if (field[0] & 0x80) {
    if (field.length !== 12 || field[0] !== 0x80 || field.readUInt32BE(0) !== 0x80000000)
      throw invalid();
    const value = field.readBigUInt64BE(4);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw invalid();
    return Number(value);
  }
  const text = field.toString("latin1").replace(/\0.*$/s, "").trim();
  if (!/^[0-7]{1,11}$/.test(text)) throw invalid();
  return parseInt(text, 8);
}
function text(field) {
  const end = field.indexOf(0);
  return field.subarray(0, end === -1 ? field.length : end).toString("utf8");
}
/** Parses one header block; `null` for a zero block. Rejects everything unexpected. */
export function parseHeader(block) {
  if (block.equals(ZERO_BLOCK)) return null;
  let sum = 0;
  for (let index = 0; index < BLOCK; index++)
    sum += index >= 148 && index < 156 ? 0x20 : block[index];
  if (
    parseNumber(block.subarray(148, 156)) !== sum ||
    !block.subarray(257, 265).equals(MAGIC) ||
    // No link targets and no ustar prefix: names come whole or through PAX.
    block.subarray(157, 257).some((byte) => byte !== 0) ||
    block.subarray(345, 500).some((byte) => byte !== 0)
  )
    throw invalid();
  const type = String.fromCharCode(block[156]);
  if (type !== "0" && type !== "x") throw invalid();
  return {
    name: text(block.subarray(0, 100)),
    mode: parseNumber(block.subarray(100, 108)),
    size: parseNumber(block.subarray(124, 136)),
    type,
  };
}
/** The `path` of a PAX extended header; any other record is rejected. */
export function parsePax(bytes) {
  let offset = 0,
    name;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space === -1 || space - offset > 6) throw invalid();
    const length = Number(bytes.toString("latin1", offset, space));
    if (
      !Number.isSafeInteger(length) ||
      length <= space - offset ||
      offset + length > bytes.length
    )
      throw invalid();
    const record = bytes.toString("utf8", space + 1, offset + length);
    if (!record.endsWith("\n") || !record.startsWith("path=") || name !== undefined)
      throw invalid();
    name = record.slice(5, -1);
    offset += length;
  }
  if (!name || name.includes("\0")) throw invalid();
  return name;
}

/** Pulls exact byte counts out of an async iterable of buffers without buffering it. */
export class ByteSource {
  constructor(iterable) {
    this.iterator = iterable[Symbol.asyncIterator]();
    // Received chunks not yet consumed; joined only for exact reads.
    this.parts = [];
    this.length = 0;
    this.done = false;
  }
  async fill() {
    if (this.done) return false;
    let next;
    try {
      next = await this.iterator.next();
    } catch {
      // Truncated or corrupt compression.
      throw invalid();
    }
    const { value, done } = next;
    if (done) {
      this.done = true;
      return false;
    }
    if (value.length) {
      this.parts.push(value);
      this.length += value.length;
    }
    return true;
  }
  /** Puts `bytes` back in front of the unread data. */
  unshift(bytes) {
    this.parts.unshift(bytes);
    this.length += bytes.length;
  }
  take(count) {
    const first = this.parts[0];
    const piece = first.subarray(0, Math.min(count, first.length));
    if (piece.length === first.length) this.parts.shift();
    else this.parts[0] = first.subarray(piece.length);
    this.length -= piece.length;
    return piece;
  }
  /** Exactly `count` bytes, or a truncation error. */
  async exact(count) {
    while (this.length < count) if (!(await this.fill())) throw invalid();
    if (this.parts[0]?.length >= count) return this.take(count);
    const pieces = [];
    for (let left = count; left > 0; left -= pieces.at(-1).length)
      pieces.push(this.take(left));
    return Buffer.concat(pieces, count);
  }
  /** Yields the next `count` bytes in the chunks they arrive in. */
  async *chunks(count) {
    let left = count;
    while (left > 0) {
      if (!this.length && !(await this.fill())) throw invalid();
      const piece = this.take(left);
      left -= piece.length;
      yield piece;
    }
  }
  /** Reads the rest; anything but zero bytes (tar record padding) is rejected. */
  async zeroTail(limit) {
    let seen = 0;
    for (;;) {
      for (const part of this.parts) if (part.some((byte) => byte !== 0)) throw invalid();
      seen += this.length;
      if (seen > limit) throw invalid();
      this.parts = [];
      this.length = 0;
      if (!(await this.fill())) return;
    }
  }
  close() {
    return this.iterator.return?.();
  }
}

/**
 * The next regular file entry: `{ name, size }` with `name` taken from a preceding
 * PAX header when present, or `null` at the end-of-archive marker.
 */
export async function nextEntry(source) {
  let block = parseHeader(await source.exact(BLOCK));
  if (!block) {
    if (parseHeader(await source.exact(BLOCK))) throw invalid();
    return null;
  }
  let name = block.name;
  if (block.type === "x") {
    if (block.size > PAX_LIMIT) throw invalid();
    const record = await source.exact(block.size);
    await zeroPadding(source, block.size);
    name = parsePax(record);
    block = parseHeader(await source.exact(BLOCK));
    if (!block || block.type !== "0") throw invalid();
  }
  if (block.mode !== 0o600) throw invalid();
  return { name, size: block.size };
}
export async function zeroPadding(source, size) {
  const bytes = await source.exact(padding(size).length);
  if (bytes.some((byte) => byte !== 0)) throw invalid();
}
