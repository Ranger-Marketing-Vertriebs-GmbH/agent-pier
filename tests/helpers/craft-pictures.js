import { crc32, deflateSync } from "node:zlib";

// Picture bytes for the rebuild picture tests: a real PNG, and just enough of the
// other formats for chat-image-probe.js rasterType to recognise them.

const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
};

/**
 * A real PNG of `width` × `height` that browsers draw: a band of `colors` (RGB) per
 * third of its height, like a page's header, body and footer.
 */
export function png(
  width = 2,
  height = 2,
  colors = [
    [244, 154, 88],
    [40, 41, 45],
    [90, 140, 220],
  ],
) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const color =
      colors[Math.min(colors.length - 1, Math.floor((y * colors.length) / height))];
    rows.push(Buffer.from([0, ...Array.from({ length: width }, () => color).flat()]));
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A JPEG header: an APP0 segment, then a baseline frame of `width` × `height`. */
export function jpeg(width = 2, height = 2) {
  const frame = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1]),
    Buffer.from([0, 1, 0, 0]),
    frame,
    Buffer.from([0xff, 0xd9]),
  ]);
}

/** A lossless WebP header of `width` × `height`. */
export function webp(width = 2, height = 2) {
  const body = Buffer.alloc(30);
  body.write("RIFF", 0, "ascii");
  body.writeUInt32LE(22, 4);
  body.write("WEBPVP8L", 8, "ascii");
  body.writeUInt32LE(9, 16);
  body[20] = 0x2f;
  body.writeUInt32LE(((width - 1) & 0x3fff) | (((height - 1) & 0x3fff) << 14), 21);
  return body;
}

/** A GIF header of `width` × `height`. */
export function gif(width = 2, height = 2) {
  const body = Buffer.alloc(13);
  body.write("GIF89a", 0, "ascii");
  body.writeUInt16LE(width, 6);
  body.writeUInt16LE(height, 8);
  return body;
}

/** An AVIF header: a raster image Craft Anything does not take. */
export function avif() {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write("ftypavif", 4, "ascii");
  box.write("mif1avif", 16, "ascii");
  return box;
}
