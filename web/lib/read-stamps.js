// When the server began the read behind a REST answer (its `X-Read-Started` header,
// server/lib/read-stamp.js), kept beside the parsed body. Live frames carry the same
// stamp as `readAt`, so a hook can keep whichever of the two was read later.
const stamps = new WeakMap();

/** The header's stamp as a number, or null. */
export const parseReadStamp = (value) => {
  const stamp = Number(value);
  return value && Number.isSafeInteger(stamp) && stamp > 0 ? stamp : null;
};

/** Remembers `stamp` for the answer `data` (an object or array). */
export function noteReadStamp(data, stamp) {
  if (data && typeof data === "object" && stamp !== null) stamps.set(data, stamp);
  return data;
}

/** The read stamp of an answer `data`, or null when the server sent none. */
export const readStampOf = (data) =>
  (data && typeof data === "object" && stamps.get(data)) || null;
