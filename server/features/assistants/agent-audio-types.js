// Audio files agents share (agent-share-store.js), recognised by their first bytes:
// the chat plays them inline. Owners do not send audio; this only types shares.
export const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/ogg",
  "audio/wav",
  "audio/flac",
  "audio/mp4",
]);
const audioBrands = new Set(["M4A ", "M4B "]);
// kbit/s per MPEG version (1, or 2 and 2.5) and layer (I, II, III); index 0 is
// "free" and 15 reserved, both refused.
const bitrates = {
  1: {
    1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  },
  2: {
    1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  },
};
// Hz by version bits (3: MPEG 1, 2: MPEG 2, 0: MPEG 2.5; 1 is reserved).
const sampleRates = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

/** The length of the MPEG audio frame whose header starts at `at`, or 0. */
function frameLength(head, at) {
  if (at + 4 > head.length || head[at] !== 0xff || (head[at + 1] & 0xe0) !== 0xe0)
    return 0;
  const version = (head[at + 1] >> 3) & 3;
  const layer = 4 - ((head[at + 1] >> 1) & 3);
  const rateIndex = head[at + 2] >> 4;
  const sampleIndex = (head[at + 2] >> 2) & 3;
  if (
    version === 1 ||
    layer === 4 ||
    rateIndex === 0 ||
    rateIndex === 15 ||
    sampleIndex === 3
  )
    return 0;
  const bitrate = bitrates[version === 3 ? 1 : 2][layer][rateIndex] * 1000;
  const rate = sampleRates[version][sampleIndex];
  const padding = (head[at + 2] >> 1) & 1;
  if (layer === 1) return Math.floor((12 * bitrate) / rate + padding) * 4;
  const factor = layer === 3 && version !== 3 ? 72 : 144;
  return Math.floor((factor * bitrate) / rate) + padding;
}

/** The type of an audio file from its first bytes, or null. */
export function audioType(head) {
  if (!Buffer.isBuffer(head) || head.length < 4) return null;
  const tag = head.toString("latin1", 0, 4);
  // An ID3v2 tag: a known major version, no 0xFF in its version bytes.
  if (
    tag.startsWith("ID3") &&
    head.length >= 10 &&
    [2, 3, 4].includes(head[3]) &&
    head[4] < 0xff
  )
    return "audio/mpeg";
  // MPEG audio frames: a valid header, and the next frame where its length ends.
  const length = frameLength(head, 0);
  if (length && frameLength(head, length)) return "audio/mpeg";
  if (tag === "OggS") return "audio/ogg";
  if (tag === "fLaC") return "audio/flac";
  if (tag === "RIFF" && head.length >= 12 && head.toString("latin1", 8, 12) === "WAVE")
    return "audio/wav";
  if (
    head.length >= 12 &&
    head.toString("latin1", 4, 8) === "ftyp" &&
    audioBrands.has(head.toString("latin1", 8, 12))
  )
    return "audio/mp4";
  return null;
}
