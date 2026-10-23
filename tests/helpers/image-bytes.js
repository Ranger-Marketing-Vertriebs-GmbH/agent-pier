// Small images whose headers detectAttachment accepts (agent-attachment-types.js).
export const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
// A JPEG with an APP0 segment and a baseline frame header of width × height.
export const jpegOf = (width = 640, height = 480) => {
  const frame = Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 0, 0, 0, 3, ...Array(9).fill(0)]);
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]),
    Buffer.alloc(14),
    frame,
    Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9]),
  ]);
};
// A lossy WebP header declaring width × height.
export const webpOf = (width = 320, height = 200) => {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0, "ascii");
  header.write("WEBP", 8, "ascii");
  header.write("VP8 ", 12, "ascii");
  header.set([0x9d, 0x01, 0x2a], 23);
  header.writeUInt16LE(width, 26);
  header.writeUInt16LE(height, 28);
  return header;
};
