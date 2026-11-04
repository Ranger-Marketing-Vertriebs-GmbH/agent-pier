// One whole-run diff read per run and re-read key, shared by every view that shows or
// checks it (the Changes view, the gate form, each waiting member's form). The first
// user starts the read; later users with the same key get the same answer. The read is
// dropped (and aborted while it runs) when its last user lets go, so the next user with
// that key reads again.
const reads = new Map();

/**
 * Joins the read for `key`, starting it with `read(signal)` when none is shared.
 * Returns its `promise` and `release()`, which a user calls once when done.
 * @param {string} key
 * @param {(signal: AbortSignal) => Promise<unknown>} read
 */
export function sharedRunDiff(key, read) {
  let entry = reads.get(key);
  if (!entry) {
    const controller = new AbortController();
    entry = { users: 0, controller, promise: read(controller.signal) };
    // the users ignore the result after release; this keeps an abort from going unhandled
    entry.promise.catch(() => {});
    reads.set(key, entry);
  }
  entry.users += 1;
  const joined = entry;
  let released = false;
  return {
    promise: joined.promise,
    release() {
      if (released) return;
      released = true;
      joined.users -= 1;
      if (joined.users > 0) return;
      if (reads.get(key) === joined) reads.delete(key);
      joined.controller.abort();
    },
  };
}
