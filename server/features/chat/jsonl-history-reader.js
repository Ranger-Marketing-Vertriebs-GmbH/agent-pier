import fs from "node:fs/promises";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { problem } from "../../lib/storage.js";
import { serverMessages } from "../../lib/i18n/de.js";

const BLOCK = 64 * 1024;
export const MAX_PAGE_BYTES = 64 * 1024 * 1024;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const mismatch = () => problem(serverMessages.chat.sessionHistoryMismatch, 409);
const parse = (bytes) => {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
};

/** Random-access reader: offsets are bytes, so split UTF-8 characters remain intact. */
export class JsonlHistoryReader {
  static async open(file, state) {
    let handle;
    try {
      handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      const reader = new JsonlHistoryReader(file, handle);
      const info = await handle.stat();
      if (!info.isFile()) throw mismatch();
      reader.identity = state || {
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        mtime: info.mtimeMs,
        prefixLength: Math.min(4096, info.size),
        tailLength: Math.min(256, info.size),
      };
      if (state) await reader.validate();
      else {
        reader.identity.prefix = digest(
          await reader.bytes(0, reader.identity.prefixLength),
        );
        reader.identity.tail = digest(
          await reader.bytes(
            info.size - reader.identity.tailLength,
            reader.identity.tailLength,
          ),
        );
      }
      return reader;
    } catch (error) {
      await handle?.close();
      if (state && ["ENOENT", "ELOOP"].includes(error.code)) throw mismatch();
      throw error;
    }
  }
  constructor(file, handle) {
    this.file = file;
    this.handle = handle;
    this.readBytes = 0;
  }
  async bytes(position, length) {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await this.handle.read(
        buffer,
        offset,
        length - offset,
        position + offset,
      );
      this.readBytes += bytesRead;
      if (!bytesRead) throw mismatch();
      offset += bytesRead;
    }
    return buffer;
  }
  async validate() {
    const info = await fs.stat(this.file);
    const value = this.identity;
    if (
      info.dev !== value.dev ||
      info.ino !== value.ino ||
      info.size < value.size ||
      (info.size === value.size && info.mtimeMs !== value.mtime)
    )
      throw mismatch();
    if (
      digest(await this.bytes(0, value.prefixLength)) !== value.prefix ||
      digest(await this.bytes(value.size - value.tailLength, value.tailLength)) !==
        value.tail
    )
      throw mismatch();
  }
  async metadata() {
    let pending = Buffer.alloc(0);
    for (let position = 0; position < this.identity.size;) {
      const chunk = await this.bytes(
        position,
        Math.min(BLOCK, this.identity.size - position),
      );
      position += chunk.length;
      pending = Buffer.concat([pending, chunk]);
      let end;
      while ((end = pending.indexOf(10)) >= 0) {
        const record = parse(pending.subarray(0, end));
        pending = pending.subarray(end + 1);
        if (record?.cwd && record.sessionId && !record.isSidechain) return record;
      }
      if (position >= MAX_PAGE_BYTES)
        throw problem(serverMessages.chat.historyTooLarge, 413);
    }
    throw problem(serverMessages.chat.sessionHistoryBeingWritten, 404);
  }
  async *backwards(end = this.identity.size, complete = false) {
    let position = end,
      pending = Buffer.alloc(0),
      boundary = end;
    // A continuation ends immediately after a newline. Initial reads must first
    // discard the incomplete final record (or the empty suffix after a newline).
    let skipTail = !complete;
    if (complete && end > 0) {
      position--;
      boundary--;
    }
    while (position > 0) {
      const start = Math.max(0, position - BLOCK);
      const chunk = await this.bytes(start, position - start);
      pending = Buffer.concat([chunk, pending]);
      position = start;
      let newline;
      while ((newline = pending.lastIndexOf(10)) >= 0) {
        const line = pending.subarray(newline + 1);
        const lineStart = position + newline + 1;
        if (skipTail) skipTail = false;
        else {
          const record = parse(line);
          if (record) yield { record, start: lineStart, end: boundary };
        }
        boundary = lineStart - 1;
        pending = pending.subarray(0, newline);
      }
      if (pending.length > MAX_PAGE_BYTES || this.readBytes > MAX_PAGE_BYTES * 2)
        throw problem(serverMessages.chat.historyTooLarge, 413);
    }
    if (!skipTail && pending.length) {
      const record = parse(pending);
      if (record) yield { record, start: 0, end: boundary };
    }
  }
  close() {
    return this.handle.close();
  }
}
