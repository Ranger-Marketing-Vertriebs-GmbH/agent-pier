import { pipeline } from "node:stream/promises";

/**
 * The one byte range a request asks for (RFC 9110, section 14): `{ start, end }`
 * (inclusive), "unsatisfiable", or null for the whole file. Several ranges, a
 * conditional If-Range and malformed headers get the whole file, as the RFC allows.
 */
export function requestedRange(header, ifRange, size) {
  if (typeof header !== "string" || ifRange) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!suffix) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (match[2] && Number(match[2]) < start) return null;
  if (start >= size) return "unsatisfiable";
  return { start, end };
}

/**
 * Sends an open file (`handle`, `size`) with range support: 206 for a range, 416
 * when it lies past the end, 200 otherwise. Headers set before stay. The handle is
 * closed in every case.
 */
export async function sendFileRange(req, res, { handle, size }) {
  try {
    const range = requestedRange(req.get("range"), req.get("if-range"), size);
    res.set("Accept-Ranges", "bytes");
    if (range === "unsatisfiable") {
      res.status(416).set("Content-Range", `bytes */${size}`).end();
      return;
    }
    const { start, end } = range || { start: 0, end: size - 1 };
    if (range) res.status(206).set("Content-Range", `bytes ${start}-${end}/${size}`);
    res.set("Content-Length", String(end - start + 1));
    if (req.method === "HEAD" || size === 0) {
      res.end();
      return;
    }
    const stream = handle.createReadStream({ start, end, autoClose: false });
    await pipeline(stream, res).catch(() => {
      // The player went away or seeked elsewhere; nothing more is owed.
    });
  } finally {
    await handle.close().catch(() => {});
  }
}
