// A picture's size in pixels from its header, so a picture that would decode to an
// enormous bitmap (a decompression bomb for the builder) is refused before Craft
// Anything or its builder opens it. The most pixels are those of a 16K screen, the
// limit Craft Anything 0.6.0 sets for pasted pictures (MAX_PASTED_PIXELS).
export const MAX_PICTURE_PIXELS = 15360 * 8640;

// JPEG start-of-frame markers: SOF0–SOF15 without DHT (C4), JPG (C8) and DAC (CC).
const startOfFrame = (marker) =>
  marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
// Markers without a length: TEM, RST0–7, SOI.
const standalone = (marker) => marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8);

function jpegSize(body) {
  let at = 2;
  while (at + 9 <= body.length) {
    if (body[at] !== 0xff) return null;
    const marker = body[at + 1];
    if (marker === 0xff) at += 1;
    else if (startOfFrame(marker))
      return { width: body.readUInt16BE(at + 7), height: body.readUInt16BE(at + 5) };
    else if (standalone(marker)) at += 2;
    else if (marker === 0xd9 || marker === 0xda) return null;
    else at += 2 + body.readUInt16BE(at + 2);
  }
  return null;
}

function webpSize(body) {
  if (body.length < 30) return null;
  const chunk = body.toString("ascii", 12, 16);
  if (chunk === "VP8 ")
    return {
      width: body.readUInt16LE(26) & 0x3fff,
      height: body.readUInt16LE(28) & 0x3fff,
    };
  if (chunk === "VP8L") {
    const bits = body.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X")
    return { width: body.readUIntLE(24, 3) + 1, height: body.readUIntLE(27, 3) + 1 };
  return null;
}

/**
 * `{ width, height }` of a picture of `type` (rasterType's PNG, GIF, WebP or JPEG),
 * or null when its header does not say.
 */
export function pictureSize(body, type) {
  if (type === "image/png" && body.length >= 24)
    return { width: body.readUInt32BE(16), height: body.readUInt32BE(20) };
  if (type === "image/gif" && body.length >= 10)
    return { width: body.readUInt16LE(6), height: body.readUInt16LE(8) };
  if (type === "image/webp") return webpSize(body);
  if (type === "image/jpeg") return jpegSize(body);
  return null;
}
