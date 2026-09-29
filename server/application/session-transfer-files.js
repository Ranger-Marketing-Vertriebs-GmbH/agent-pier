import fs from "node:fs/promises";
import { constants, createWriteStream } from "node:fs";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { problem } from "../lib/storage.js";
import { serverMessages } from "../lib/i18n/de.js";

const fail = (key) => problem(serverMessages.sessionTransfer[key], 409);
const MAX_RECORD = 64 * 1024 * 1024;
const unchanged = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

async function open(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw fail("unsafeFile");
    return { handle, stat };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

// Keep only one JSONL record in memory. Tool output can be large, so bound each
// record independently without imposing a limit on the whole conversation.
function recordReader(onRecord) {
  let parts = [],
    size = 0;
  function append(bytes) {
    size += bytes.length;
    if (size > MAX_RECORD) throw fail("tooLarge");
    if (bytes.length) parts.push(bytes);
  }
  function flush() {
    const text = Buffer.concat(parts, size).toString("utf8").trim();
    parts = [];
    size = 0;
    if (!text) return;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      throw fail("incomplete");
    }
    if (!record || typeof record !== "object" || Array.isArray(record))
      throw fail("incomplete");
    onRecord(record);
  }
  return {
    write(chunk) {
      let start = 0,
        end;
      while ((end = chunk.indexOf(10, start)) >= 0) {
        append(chunk.subarray(start, end));
        flush();
        start = end + 1;
      }
      append(chunk.subarray(start));
    },
    finish: flush,
  };
}

export async function fingerprint(file, { prefixSize = 0, onRecord } = {}) {
  const { handle, stat } = await open(file);
  const hash = createHash("sha256"),
    prefix = createHash("sha256");
  const records = onRecord && recordReader(onRecord);
  let position = 0;
  try {
    if (stat.size) {
      const stream = handle.createReadStream({ end: stat.size - 1, autoClose: false });
      for await (const chunk of stream) {
        hash.update(chunk);
        if (position < prefixSize)
          prefix.update(chunk.subarray(0, prefixSize - position));
        position += chunk.length;
        records?.write(chunk);
      }
    }
    records?.finish();
    if (
      position !== stat.size ||
      !unchanged(stat, await handle.stat()) ||
      !unchanged(stat, await fs.lstat(file))
    )
      throw fail("changedDuringPreparation");
    return { size: position, hash: hash.digest("hex"), prefix: prefix.digest("hex") };
  } finally {
    await handle.close();
  }
}

export async function optionalFingerprint(file) {
  try {
    return await fingerprint(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

export const sameFingerprint = (a, b) =>
  a === null || b === null ? a === b : a.size === b.size && a.hash === b.hash;

export async function stageFile(source, temp, expected) {
  const { handle, stat } = await open(source);
  try {
    if (stat.size !== expected.size) throw fail("changedDuringPreparation");
    await pipeline(
      handle.createReadStream({ autoClose: false }),
      createWriteStream(temp, { flags: "wx", mode: 0o600 }),
    );
    if (!sameFingerprint(await fingerprint(temp), expected))
      throw fail("changedDuringPreparation");
  } finally {
    await handle.close();
  }
}

export function historyValidator(session, id, historyMode) {
  let meta,
    ordinal = 0;
  return {
    record(record) {
      if (session.tool === "codex") {
        if (!meta && record.type === "session_meta") meta = record.payload;
        if (historyMode === "paginated" && record.ordinal !== ordinal)
          throw fail("notPortable");
      } else if (!meta && record.sessionId && record.cwd && !record.isSidechain)
        meta = record;
      ordinal++;
    },
    finish() {
      if ((meta?.id || meta?.sessionId) !== id || meta.cwd !== session.cwd)
        throw fail("identityMismatch");
      if (session.tool === "codex" && (meta.history_mode || "legacy") !== historyMode)
        throw fail("notPortable");
    },
  };
}
