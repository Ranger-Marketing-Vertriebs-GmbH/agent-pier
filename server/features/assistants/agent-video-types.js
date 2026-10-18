// Videos the owner sends an agent: MP4, QuickTime (iPhone) and WebM, recognised by
// their container bytes. They travel in chunks (agent-video-uploads.js) and stay
// files in the agent's workspace; no model receives them inline.
export const MAX_VIDEO_BYTES = 200 * 1024 * 1024;
// One upload request carries at most this much; a phone on a slow line then never
// meets the server's request timeout, and a failed chunk is retried on its own.
export const VIDEO_CHUNK_BYTES = 8 * 1024 * 1024;
// The bytes a type is recognised from: the ftyp box or the EBML header.
export const VIDEO_HEAD_BYTES = 4096;
export const VIDEO_TYPES = new Set(["video/mp4", "video/quicktime", "video/webm"]);
export const videoExtensions = {
  "video/mp4": [".mp4", ".m4v"],
  "video/quicktime": [".mov", ".qt"],
  "video/webm": [".webm"],
};

const quicktime = "qt  ";
const mp4Brands = new Set([
  ..."isom iso2 iso3 iso4 iso5 iso6 iso7 iso8 iso9 mp41 mp42 mp71 avc1 dash MSNV f4v".split(
    " ",
  ),
  "M4V ",
  "M4VH",
  "M4VP",
  "f4v ",
]);
// HEIF images and image sequences: stills, handled by agent-attachment-types.js.
const imageBrands = new Set(
  "heic heix hevc hevx heim heis mif1 msf1 avif avis".split(" "),
);

function ftypBrands(bytes) {
  if (bytes.length < 16 || bytes.toString("latin1", 4, 8) !== "ftyp") return null;
  const size = bytes.readUInt32BE(0);
  if (size < 16 || size > Math.min(bytes.length, VIDEO_HEAD_BYTES) || size % 4)
    return null;
  const brands = [bytes.toString("latin1", 8, 12)];
  for (let offset = 16; offset + 4 <= size; offset += 4)
    brands.push(bytes.toString("latin1", offset, offset + 4));
  return brands;
}

/** An EBML variable-length integer at `offset`: { value, length }, or null. */
function vint(bytes, offset, keepMarker = false) {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || offset + length > bytes.length) return null;
  let value = BigInt(keepMarker ? first : first & (0xff >> length));
  let ones = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    value = (value << 8n) | BigInt(bytes[offset + i]);
    ones &&= bytes[offset + i] === 0xff;
  }
  return { value, length, unknown: !keepMarker && ones };
}

// The children of one EBML element body, each as { id, start, end }.
function* ebmlChildren(bytes, start, end) {
  let offset = start;
  for (let count = 0; offset < end && count < 4096; count++) {
    const id = vint(bytes, offset, true);
    if (!id || id.length > 4) return;
    const size = vint(bytes, offset + id.length);
    if (!size) return;
    const body = offset + id.length + size.length;
    const close = size.unknown ? end : body + Number(size.value);
    if (!size.unknown && size.value > BigInt(end - body)) {
      // The rest of the file; only what was read is walked.
      yield { id: Number(id.value), start: body, end, cut: true };
      return;
    }
    yield { id: Number(id.value), start: body, end: close, unknown: size.unknown };
    offset = close;
  }
}

const EBML = 0x1a45dfa3;
function webmDocType(bytes) {
  if (bytes.length < 8 || bytes.readUInt32BE(0) !== EBML) return null;
  const [header] = ebmlChildren(bytes, 0, bytes.length);
  if (!header || header.id !== EBML) return null;
  for (const child of ebmlChildren(bytes, header.start, header.end))
    if (child.id === 0x4282) return bytes.toString("latin1", child.start, child.end);
  return null;
}

/** The type of a video from its first bytes, or null. */
export function videoType(head) {
  if (!Buffer.isBuffer(head) || !head.length) return null;
  const brands = ftypBrands(head);
  if (brands) {
    if (imageBrands.has(brands[0])) return null;
    if (brands[0] === quicktime) return "video/quicktime";
    if (mp4Brands.has(brands[0])) return "video/mp4";
    if (brands.some((brand) => imageBrands.has(brand))) return null;
    if (brands.includes(quicktime)) return "video/quicktime";
    if (brands.some((brand) => mp4Brands.has(brand))) return "video/mp4";
    return null;
  }
  return webmDocType(head) === "webm" ? "video/webm" : null;
}

/** Random access over a buffer, as videoMetadata reads a file. */
export const bufferReader = (bytes) => async (offset, length) =>
  bytes.subarray(offset, Math.min(bytes.length, offset + length));

// Seconds with one decimal, from ticks of a time scale.
const seconds = (ticks, scale) => {
  if (!(scale > 0) || !(ticks >= 0)) return undefined;
  const value = Math.round((ticks * 10) / scale) / 10;
  return Number.isFinite(value) && value <= 1e7 ? value : undefined;
};
const MAX_MOVIE_BOX = 32 * 1024 * 1024;

// The boxes in a buffer range: { type, start, end } with start after the header.
function* boxes(bytes, start = 0, end = bytes.length) {
  let offset = start;
  for (let count = 0; offset + 8 <= end && count < 4096; count++) {
    let size = bytes.readUInt32BE(offset);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > end) return;
      size = Number(bytes.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) size = end - offset;
    if (size < header || offset + size > end) return;
    yield {
      type: bytes.toString("latin1", offset + 4, offset + 8),
      start: offset + header,
      end: offset + size,
    };
    offset += size;
  }
}
const child = (bytes, parent, type) =>
  [...boxes(bytes, parent.start, parent.end)].find((b) => b.type === type);

function movieHeader(moov, mvhd) {
  const v1 = moov[mvhd.start] === 1;
  if (mvhd.end - mvhd.start < (v1 ? 32 : 20)) return undefined;
  const scale = moov.readUInt32BE(mvhd.start + (v1 ? 20 : 12));
  const ticks = v1
    ? Number(moov.readBigUInt64BE(mvhd.start + 24))
    : moov.readUInt32BE(mvhd.start + 16);
  // All ones: the duration is unknown.
  return ticks === 0xffffffff ? undefined : seconds(ticks, scale);
}

function trackSize(moov, trak) {
  const mdia = child(moov, trak, "mdia");
  const hdlr = mdia && child(moov, mdia, "hdlr");
  if (!hdlr || hdlr.end - hdlr.start < 12) return null;
  if (moov.toString("latin1", hdlr.start + 8, hdlr.start + 12) !== "vide") return null;
  const tkhd = child(moov, trak, "tkhd");
  if (!tkhd) return null;
  const v1 = moov[tkhd.start] === 1;
  const at = tkhd.start + (v1 ? 52 : 40);
  if (tkhd.end < at + 44) return null;
  const width = Math.round(moov.readUInt32BE(at + 36) / 0x10000);
  const height = Math.round(moov.readUInt32BE(at + 40) / 0x10000);
  if (!width || !height) return null;
  // A matrix turned by a quarter (iPhone portrait) shows the frame on its side.
  const [a, b] = [moov.readInt32BE(at), moov.readInt32BE(at + 4)];
  return a === 0 && Math.abs(b) === 0x10000
    ? { width: height, height: width }
    : { width, height };
}

async function mp4Metadata(read, size) {
  let offset = 0;
  for (let count = 0; offset + 8 <= size && count < 4096; count++) {
    const header = await read(offset, 16);
    if (header.length < 8) return null;
    let length = header.readUInt32BE(0);
    let skip = 8;
    if (length === 1) {
      if (header.length < 16) return null;
      length = Number(header.readBigUInt64BE(8));
      skip = 16;
    } else if (length === 0) length = size - offset;
    if (length < skip || offset + length > size) return null;
    if (header.toString("latin1", 4, 8) === "moov") {
      if (length > MAX_MOVIE_BOX) return null;
      const moov = await read(offset + skip, length - skip);
      if (moov.length !== length - skip) return null;
      const whole = { start: 0, end: moov.length };
      const mvhd = child(moov, whole, "mvhd");
      if (!mvhd) return null;
      const result = {};
      const duration = movieHeader(moov, mvhd);
      if (duration !== undefined) result.duration = duration;
      for (const trak of boxes(moov, 0, moov.length)) {
        if (trak.type !== "trak") continue;
        const dimensions = trackSize(moov, trak);
        if (dimensions) {
          Object.assign(result, dimensions);
          break;
        }
      }
      return result;
    }
    offset += length;
  }
  return null;
}

const WEBM_SCAN_BYTES = 1024 * 1024;
const ebmlUint = (bytes, el) => {
  if (el.end - el.start < 1 || el.end - el.start > 8) return undefined;
  let value = 0;
  for (let i = el.start; i < el.end; i++) value = value * 256 + bytes[i];
  return value;
};
const ebmlFloat = (bytes, el) =>
  el.end - el.start === 8
    ? bytes.readDoubleBE(el.start)
    : el.end - el.start === 4
      ? bytes.readFloatBE(el.start)
      : undefined;

function webmTracks(bytes, tracks, result) {
  for (const entry of ebmlChildren(bytes, tracks.start, tracks.end)) {
    if (entry.id !== 0xae) continue;
    const fields = [...ebmlChildren(bytes, entry.start, entry.end)];
    if (ebmlUint(bytes, fields.find((f) => f.id === 0x83) || {}) !== 1) continue;
    const video = fields.find((f) => f.id === 0xe0);
    if (!video) continue;
    const pixels = [...ebmlChildren(bytes, video.start, video.end)];
    const width = ebmlUint(bytes, pixels.find((f) => f.id === 0xb0) || {});
    const height = ebmlUint(bytes, pixels.find((f) => f.id === 0xba) || {});
    if (width && height) Object.assign(result, { width, height });
    return;
  }
}

async function webmMetadata(read, size) {
  const bytes = await read(0, Math.min(size, WEBM_SCAN_BYTES));
  if (webmDocType(bytes) !== "webm") return null;
  const result = {};
  for (const top of ebmlChildren(bytes, 0, bytes.length)) {
    if (top.id !== 0x18538067) continue;
    let scale = 1_000_000;
    let ticks;
    for (const part of ebmlChildren(bytes, top.start, top.end)) {
      if (part.id === 0x1f43b675) break; // the first cluster: the media begins
      if (part.id === 0x1549a966)
        for (const field of ebmlChildren(bytes, part.start, part.end)) {
          if (field.id === 0x2ad7b1) scale = ebmlUint(bytes, field) || scale;
          if (field.id === 0x4489) ticks = ebmlFloat(bytes, field);
        }
      if (part.id === 0x1654ae6b) webmTracks(bytes, part, result);
    }
    const duration = ticks === undefined ? undefined : seconds(ticks * scale, 1e9);
    if (duration !== undefined) result.duration = duration;
    break;
  }
  return result;
}

/**
 * What the agent and the chat learn of a video without decoding it: duration in
 * seconds and display size in pixels, each when the container states it. Null when
 * the bytes are not the container their type claims (an MP4 needs its movie box).
 * `read(offset, length)` resolves with at most `length` bytes.
 */
export async function videoMetadata(type, read, size) {
  try {
    if (type === "video/webm") return await webmMetadata(read, size);
    if (type === "video/mp4" || type === "video/quicktime")
      return await mp4Metadata(read, size);
  } catch {
    /* Malformed containers are refused below. */
  }
  return null;
}

/** 42 → "0:42", 3723 → "1:02:03". */
export function formatDuration(value) {
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** The note's details for a video: ", 0:42, 1920x1080" as far as they are known. */
export function videoDetails(video) {
  if (!video) return "";
  return [
    Number.isFinite(video.duration) ? formatDuration(video.duration) : "",
    video.width && video.height ? `${video.width}x${video.height}` : "",
  ]
    .filter(Boolean)
    .map((part) => `, ${part}`)
    .join("");
}

// Model input, in English like the rest of the note.
export const VIDEO_NOTE =
  "[Videos reach you only as these files: you cannot watch them directly. Work with the saved file using your tools if you need more than the details above.]";
