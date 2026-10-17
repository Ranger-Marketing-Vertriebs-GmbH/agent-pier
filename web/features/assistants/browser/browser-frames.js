/**
 * Decodes one live-view frame as OpenClaw sends it (browser-live-view.js): a
 * four-byte big-endian header length, a JSON header and the JPEG. Returns
 * `{ header, jpeg }` or null for a malformed frame.
 */
export function decodeFrame(buffer) {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength < 4) return null;
  const length = new DataView(buffer).getUint32(0);
  if (length > buffer.byteLength - 4 || length > 65536) return null;
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
  } catch {
    return null;
  }
  const jpeg = new Uint8Array(buffer, 4 + length);
  return jpeg.length ? { header, jpeg } : null;
}

/** The stream's address for agent `id`; `preview` asks for one frame a second. */
export const streamAddress = (id, preview = false, origin = globalThis.location) =>
  `${origin.protocol === "https:" ? "wss:" : "ws:"}//${origin.host}/api/assistants/${encodeURIComponent(id)}/browser-stream${preview ? "?preview=1" : ""}`;
