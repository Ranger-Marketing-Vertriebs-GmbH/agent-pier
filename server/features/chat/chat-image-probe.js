import fs from "node:fs/promises";
import { constants } from "node:fs";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
// Disk probes per scan. Recent misses are skipped, so later scans reach older paths.
export const MAX_PROBES = 256;
const MISS_TTL = 10_000;
const MAX_ENTRIES = 4096;
const HEADER_BYTES = 4096;

export function rasterType(bytes) {
  const ascii = (start, end) => bytes.toString("ascii", start, end);
  if (
    bytes.length >= 33 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    ascii(12, 16) === "IHDR"
  ) {
    const width = bytes.readUInt32BE(16),
      height = bytes.readUInt32BE(20);
    if (width && height && width * height <= 80_000_000) return "image/png";
    return null;
  }
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(ascii(0, 6))) {
    const width = bytes.readUInt16LE(6),
      height = bytes.readUInt16LE(8);
    if (width && height && width * height <= 80_000_000) return "image/gif";
    return null;
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 20 &&
    ascii(0, 4) === "RIFF" &&
    ascii(8, 12) === "WEBP" &&
    ["VP8 ", "VP8L", "VP8X"].includes(ascii(12, 16))
  )
    return "image/webp";
  if (bytes.length >= 24 && ascii(4, 8) === "ftyp") {
    const boxSize = bytes.readUInt32BE(0);
    if (boxSize < 16 || boxSize > Math.min(bytes.length, 4096) || boxSize % 4 !== 0)
      return null;
    for (let offset = 8; offset + 4 <= boxSize; offset += 4)
      if (offset !== 12 && ["avif", "avis"].includes(ascii(offset, offset + 4)))
        return "image/avif";
  }
  return null;
}

const bounded = (map, key, value) => {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ENTRIES) map.delete(map.keys().next().value);
};

/**
 * Decides whether a transcript-derived path names a raster image a card can show,
 * using the same file, symlink and size rules as the image route. Hits are reused
 * while the file's identity, size and mtime stay the same; misses expire quickly so
 * a file written later appears on a following refresh.
 */
export class ChatImageProbe {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.hits = new Map();
    this.misses = new Map();
  }
  /** A scan shares one disk budget across all of its probes. */
  scan() {
    let disk = MAX_PROBES;
    return (fullPath) => {
      if (this.misses.get(fullPath) > this.now()) return false;
      this.misses.delete(fullPath);
      // Past the budget, the last verified result stands until a later scan.
      if (disk <= 0) return this.hits.has(fullPath);
      disk -= 1;
      return this.probe(fullPath);
    };
  }
  async probe(fullPath) {
    let handle;
    try {
      const source = await fs.lstat(fullPath);
      if (!source.isFile() || source.isSymbolicLink() || source.size > MAX_IMAGE_BYTES)
        return this.miss(fullPath);
      const identity = JSON.stringify([
        source.dev,
        source.ino,
        source.size,
        source.mtimeMs,
      ]);
      if (this.hits.get(fullPath) === identity) return true;
      handle = await fs.open(fullPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile() || stat.dev !== source.dev || stat.ino !== source.ino)
        return this.miss(fullPath);
      const header = Buffer.alloc(Math.min(stat.size, HEADER_BYTES));
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (!rasterType(header.subarray(0, bytesRead))) return this.miss(fullPath);
      bounded(this.hits, fullPath, identity);
      return true;
    } catch {
      return this.miss(fullPath);
    } finally {
      await handle?.close().catch(() => {});
    }
  }
  miss(fullPath) {
    this.hits.delete(fullPath);
    bounded(this.misses, fullPath, this.now() + MISS_TTL);
    return false;
  }
}
