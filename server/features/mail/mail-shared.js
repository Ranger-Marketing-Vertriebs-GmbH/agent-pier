import { setTimeout as delay } from "node:timers/promises";

// Small rules the mail modules (and agent mail) share, each defined once.

/** A C0 control character or DEL: never in a folder, name or other agent input. */
export const controlChar = /[\u0000-\u001f\u007f]/;

/** controlChar or a Unicode line or paragraph separator: never in a header line. */
export const headerControlChar = /[\u0000-\u001f\u007f\u2028\u2029]/;

/** A programming error (a caller's bug), never a server's answer: it must surface. */
export const isBug = (error) =>
  error instanceof TypeError || error instanceof ReferenceError;

/**
 * A BODYSTRUCTURE node's decoded size estimate: base64 carries 3 bytes in 4
 * characters; any other encoding counts as it is stored.
 */
export const decodedEstimate = (node) =>
  String(node?.encoding ?? "").toLowerCase() === "base64"
    ? Math.floor(((Number(node.size) || 0) * 3) / 4)
    : Number(node?.size) || 0;

/** Whether a node is marked `Content-Disposition: attachment` (any case). */
export const markedAttachment = (node) =>
  String(node?.disposition ?? "").toLowerCase() === "attachment";

/** What byDeadline answers when the deadline came first. */
export const late = Symbol("late");

// Resolves after `ms`, or at once when `signal` aborts; never keeps the process up.
export const deadlineTimer = (ms, signal) =>
  delay(Math.max(0, ms), undefined, { signal, ref: false }).catch(() => {});

/**
 * `promise`'s value if it settles before `deadline` (ms on the `now` clock), else
 * `late`. A promise given up on is left to finish; its later failure is never an
 * unhandled rejection, and a programming error in it is still logged as `label`.
 */
export async function byDeadline(
  promise,
  deadline,
  { now = Date.now, wait = deadlineTimer, label = "Mail step failed:" } = {},
) {
  let gaveUp = false;
  promise.catch((error) => {
    if (gaveUp && isBug(error)) console.error(label, error?.name);
  });
  const stop = new AbortController();
  try {
    const result = await Promise.race([
      promise,
      wait(deadline - now(), stop.signal).then(() => late),
    ]);
    gaveUp = result === late;
    return result;
  } finally {
    stop.abort();
  }
}
