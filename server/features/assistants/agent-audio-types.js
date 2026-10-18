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

/** The type of an audio file from its first bytes, or null. */
export function audioType(head) {
  if (!Buffer.isBuffer(head) || head.length < 4) return null;
  const tag = head.toString("latin1", 0, 4);
  if (tag.startsWith("ID3")) return "audio/mpeg";
  // An MPEG audio frame: sync bits set, a layer given.
  if (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) !== 0)
    return "audio/mpeg";
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
