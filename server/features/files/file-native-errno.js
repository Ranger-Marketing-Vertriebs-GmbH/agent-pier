import koffi from "koffi";
import { getSystemErrorName } from "node:util";

/** koffi.errno() reads the thread's live errno; Koffi does not save it per call.
 * Anything V8 runs before the read, such as an allocation that starts garbage
 * collection, can make libc calls that overwrite it: on Linux a contended futex
 * leaves EAGAIN. Read errno in the calling frame directly after the failed call,
 * before any allocation or other call, and build the error from that value. */
export function nativeError(errno, message) {
  return Object.assign(new Error(message), { code: getSystemErrorName(-errno) });
}

/** Wrap a Koffi function that fails with a negative result or a NULL pointer. */
export function errnoChecked(fn, message) {
  return (...args) => {
    const result = fn(...args);
    if (result === null || (typeof result !== "object" && result < 0))
      throw nativeError(koffi.errno(), message);
    return result;
  };
}
