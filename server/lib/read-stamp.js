// One clock for when reads of server state begin: a live topic's read (live-instance.js)
// and every REST GET under /api (the `X-Read-Started` header). Stamps rise strictly, so
// the browser can keep whichever of a pushed value and a REST answer was read later
// (web/lib/live/live-topic-reader.js): a read that began after a write shows it.

export const READ_STAMP_HEADER = "X-Read-Started";

let last = 0;

/** A stamp above every earlier one; follows the clock, so it also rises across restarts. */
export function readStamp(now = Date.now()) {
  last = Math.max(now, last + 1);
  return last;
}

/** Express middleware: stamps each GET's answer with the moment its read began. */
export function readStampHeader() {
  return (req, res, next) => {
    if (req.method === "GET") res.setHeader(READ_STAMP_HEADER, String(readStamp()));
    next();
  };
}
