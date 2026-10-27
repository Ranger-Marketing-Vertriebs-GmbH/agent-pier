import { gzipSync } from "node:zlib";

// Builds a tar.gz from raw ustar headers, so tests can create hostile archives (links
// out of the folder, device files, `..` names) that the system `tar` refuses to write.
const typeFlags = { file: "0", dir: "5", symlink: "2", hardlink: "1", char: "3" };

function field(header, offset, length, value) {
  Buffer.from(value, "utf8").subarray(0, length).copy(header, offset);
}

const octal = (value, length) => value.toString(8).padStart(length - 1, "0") + "\0";

function header({ name, type, size = 0, mode = 0o644, link = "" }) {
  const block = Buffer.alloc(512);
  field(block, 0, 100, name);
  field(block, 100, 8, octal(mode, 8));
  field(block, 108, 8, octal(0, 8));
  field(block, 116, 8, octal(0, 8));
  field(block, 124, 12, octal(size, 12));
  field(block, 136, 12, octal(0, 12));
  block.fill(32, 148, 156);
  field(block, 156, 1, type);
  field(block, 157, 100, link);
  field(block, 257, 6, "ustar\0");
  field(block, 263, 2, "00");
  if (type === "3") {
    field(block, 329, 8, octal(1, 8));
    field(block, 337, 8, octal(3, 8));
  }
  const sum = block.reduce((total, byte) => total + byte, 0);
  field(block, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return block;
}

const padded = (data) =>
  Buffer.concat([data, Buffer.alloc((512 - (data.length % 512)) % 512)]);

function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  let length = Buffer.byteLength(body) + 1;
  while (String(length).length + Buffer.byteLength(body) !== length) length += 1;
  return `${length}${body}`;
}

/** The archive's uncompressed tar bytes. */
export function tar(entries) {
  const blocks = [];
  for (const entry of entries) {
    const type = typeFlags[entry.type || "file"];
    const content = Buffer.from(entry.content ?? "");
    const link = entry.link || "";
    if (entry.pax) {
      const records =
        paxRecord("path", entry.name) + (link ? paxRecord("linkpath", link) : "");
      const data = Buffer.from(records);
      blocks.push(header({ name: "PaxHeader/entry", type: "x", size: data.length }));
      blocks.push(padded(data));
    }
    if (entry.gnuLong) {
      const longName = Buffer.from(`${entry.name}\0`);
      blocks.push(header({ name: "././@LongLink", type: "L", size: longName.length }));
      blocks.push(padded(longName));
      if (link) {
        const longLink = Buffer.from(`${link}\0`);
        blocks.push(header({ name: "././@LongLink", type: "K", size: longLink.length }));
        blocks.push(padded(longLink));
      }
    }
    const size = type === "0" ? content.length : 0;
    blocks.push(
      header({
        name: entry.name,
        type,
        size,
        mode: entry.mode ?? (type === "5" ? 0o755 : 0o644),
        link,
      }),
    );
    if (size) blocks.push(padded(content));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

/** The gzip-compressed archive. */
export const tarGz = (entries) => gzipSync(tar(entries));
