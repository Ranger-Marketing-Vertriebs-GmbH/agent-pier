// When the server began the read behind a REST answer (its `X-Read-Started` header,
// server/lib/read-stamp.js), kept beside the parsed body. Live frames carry the same
// stamp as `readAt`, so a hook can keep whichever of the two was read later.
const stamps = new WeakMap();

/** The header's stamp as a number, or null. */
export const parseReadStamp = (value) => {
  const stamp = Number(value);
  return value && Number.isSafeInteger(stamp) && stamp > 0 ? stamp : null;
};

// The newest write answer's stamp and server instance (written() waits for a value
// read after it).
let lastWrite = null;

/**
 * Remembers `stamp` and the server `instance` (its `X-Read-Instance`) for the answer
 * `data` (an object or array); a `write` answer also becomes the last write.
 */
export function noteReadStamp(data, stamp, { instance = null, write = false } = {}) {
  if (stamp === null) return data;
  const noted = { stamp, instance: typeof instance === "string" ? instance : null };
  if (data && typeof data === "object") stamps.set(data, noted);
  if (write) lastWrite = noted;
  return data;
}

/** The read stamp of an answer `data`, or null when the server sent none. */
export const readStampOf = (data) =>
  (data && typeof data === "object" && stamps.get(data)?.stamp) || null;

/** The server instance that stamped the answer `data`, or null. */
export const readInstanceOf = (data) =>
  (data && typeof data === "object" && stamps.get(data)?.instance) || null;

/** `{stamp, instance}` of the newest write answer this tab got, or null. */
export const lastWriteStamp = () => lastWrite;

/**
 * Whether the answer `data` was read before a push read at `pushedAt`: a slow write's
 * answer must not replace what a newer push already showed. False when either stamp
 * is unknown.
 */
export function readBefore(data, pushedAt) {
  const answeredAt = readStampOf(data);
  return answeredAt !== null && Number.isSafeInteger(pushedAt) && answeredAt < pushedAt;
}
