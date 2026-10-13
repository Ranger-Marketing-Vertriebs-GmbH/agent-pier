// Pixel dimensions from image headers, without decoding. A huge declared size is a
// decompression bomb for the browser that shows the thumbnail and for the model
// provider that receives it inline; uploads above this are refused.
export const MAX_IMAGE_PIXELS = 80_000_000;
const SOF = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegSize(bytes) {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    offset += 2;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue;
    // Image data or the end before any frame header: no size to trust.
    if (marker === 0xd9 || marker === 0xda) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2) return null;
    if (SOF.has(marker))
      return {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    offset += length;
  }
  return null;
}

function webpSize(bytes) {
  const chunk = bytes.toString("ascii", 12, 16);
  if (chunk === "VP8 " && bytes.length >= 30)
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X" && bytes.length >= 30)
    return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
  return null;
}

/** Whether a JPEG or WebP declares a usable size within the pixel cap. */
export function acceptableDimensions(bytes, type) {
  const size =
    type === "image/jpeg"
      ? jpegSize(bytes)
      : type === "image/webp"
        ? webpSize(bytes)
        : {};
  if (!size) return false;
  if (!("width" in size)) return true;
  return (
    size.width > 0 && size.height > 0 && size.width * size.height <= MAX_IMAGE_PIXELS
  );
}
