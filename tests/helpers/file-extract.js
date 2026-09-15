import { deflateRawSync } from "node:zlib";
import crc32 from "buffer-crc32";
import { uploadRequest } from "./file-uploads.js";

// Deliberately permits malformed metadata so tests exercise the real ZIP reader.
export function extractionZip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const value of entries) {
    const entry = typeof value === "string" ? { name: value } : value;
    const name = Buffer.from(entry.rawName || entry.name),
      bytes = Buffer.from(entry.bytes || "");
    const compressed = entry.deflate ? deflateRawSync(bytes) : bytes;
    const header = Buffer.alloc(30),
      record = Buffer.alloc(46);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(entry.flags ?? 0x800, 6);
    header.writeUInt16LE(entry.deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc32.unsigned(bytes), 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(entry.size ?? bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(0x314, 4);
    header.copy(record, 6, 4, 28);
    if (entry.localFlags !== undefined) header.writeUInt16LE(entry.localFlags, 6);
    if (entry.corrupt && compressed.length) compressed[0] ^= 1;
    record.writeUInt32LE(
      ((entry.mode ?? (entry.name.endsWith("/") ? 0o40755 : 0o100644)) * 65536) >>> 0,
      38,
    );
    record.writeUInt32LE(offset, 42);
    local.push(header, name, compressed);
    central.push(record, name);
    offset += header.length + name.length + compressed.length;
  }
  const directory = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}
export const extractOperation = (source, target, options = {}) => ({
  requestId: uploadRequest(),
  kind: "extract",
  sources: [source],
  target,
  name: null,
  options,
});

export async function resolveExtract(f, job, decision, applyToRemaining = false) {
  const conflict = await f.until(() => f.jobs.get(f.scope, job.id).conflict);
  return f.jobs.resolve(f.scope, job.id, {
    conflictId: conflict.id,
    decision,
    applyToRemaining,
  });
}
