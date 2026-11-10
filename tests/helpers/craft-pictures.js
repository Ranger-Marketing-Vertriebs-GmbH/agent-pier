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

export const jpeg = () =>
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0]);

/** An AVIF header: a raster image Craft Anything does not take. */
export function avif() {
  const box = Buffer.alloc(24);
  box.writeUInt32BE(24, 0);
  box.write("ftypavif", 4, "ascii");
  box.write("mif1avif", 16, "ascii");
  return box;
}
