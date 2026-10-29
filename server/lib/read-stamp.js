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

// The server instance whose clock the stamp is on (the live hub's `hello` instance):
// after a restart the clock may have gone back, so the browser compares stamps only
// within one instance.
export const READ_INSTANCE_HEADER = "X-Read-Instance";

/**
 * Express middleware: stamps each GET's answer with the moment its read began, and a
 * write's answer (whose body the handler read after writing) with the moment it is
 * sent, so a push read after that answer was made shows over it. `instance()` names
 * the server instance (absent until the live hub exists).
 */
export function readStampHeader({ instance = () => null } = {}) {
  const name = (res) => {
    const id = instance();
    if (typeof id === "string" && id) res.setHeader(READ_INSTANCE_HEADER, id);
  };
  return (req, res, next) => {
    if (req.method === "GET") {
      res.setHeader(READ_STAMP_HEADER, String(readStamp()));
      name(res);
    } else {
      const writeHead = res.writeHead;
      res.writeHead = function (...args) {
        if (!this.headersSent) {
          this.setHeader(READ_STAMP_HEADER, String(readStamp()));
          name(this);
        }
        return writeHead.apply(this, args);
      };
    }
    next();
  };
}
