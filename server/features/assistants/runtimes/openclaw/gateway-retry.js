import { setTimeout as delay } from "node:timers/promises";

// OpenClaw marks some refusals `retryable`, but not every one did nothing: a
// models.authLogout that removed the profiles and then could not rewrite a session
// (an agent database still inspected) answers retryable too, and so do outcomes it
// cannot tell ("suggestion dispatch outcome is unknown"). GatewayClient.call repeats
// a retryable refusal only where repeating cannot run anything twice:
//
// - one the Gateway gave before dispatching the request at all: while it drains for a
//   restart or a suspension (`details.reason`, 2026.11.3, retryAfterMs 1000), or
//   before a plugin or config operation entered (`details.mutationAccepted: false`);
// - one of a read, which changes nothing either way: a models.list that a newer
//   catalog generation superseded (2026.11.2), the auth status or a probe.
//
// This layer alone repeats those; live-patch.js keeps only the control-plane budget
// of config.patch (a retryable refusal without such a reason) and passes the ones
// marked `beforeDispatch` on. A repeat goes out only on the connection that answered
// (a drain usually closes it: the supervisor reconnects, and a request sent before
// the new connection's handshake would break it), and never once that connection
// closed while waiting. Each repeat waits what the Gateway asks, 250 ms to 2 s.
// A list or status read may take whatever is left of the caller's timeout; any other
// call, a probe or a write, only goes again with at least `fullShare` of its own
// timeout left, so it ends in an answer, not an ambiguous timeout.
const beforeDispatch = new Set(["gateway-restarting", "gateway-suspending"]);
export const repeatableReads = new Set([
  "models.list",
  "models.authStatus",
  "models.probe",
]);
// Reads that may run in whatever time is left.
const shortReads = new Set(["models.list", "models.authStatus"]);
const fullShare = 0.75;

/** Whether a refusal frame's error says the Gateway did not dispatch the request. */
export const refusedBeforeDispatch = (error) =>
  error?.retryable === true &&
  (beforeDispatch.has(error.details?.reason) ||
    error.details?.mutationAccepted === false);

/** Whether `method` may be sent again after `error` (a GatewayClient rejection). */
export const repeatable = (method, error) =>
  error?.answered === true &&
  error.retryable === true &&
  (error.beforeDispatch === true || repeatableReads.has(method));

/**
 * Runs `attempt(timeoutMs)` and repeats it while `repeatable` allows, at most
 * `retries` times, all within `timeoutMs` from now; each attempt gets what is left.
 * `current()` says whether the connection that answered still serves; `signal` ends a
 * wait at once (the connection closed). Either way the refusal is passed on.
 */
export async function repeating(
  method,
  attempt,
  {
    timeoutMs,
    current = () => true,
    signal,
    retries = 10,
    minWaitMs = 250,
    maxWaitMs = 2000,
    sleep = delay,
    now = Date.now,
  },
) {
  const deadline = now() + timeoutMs;
  const floor = shortReads.has(method) ? 0 : timeoutMs * fullShare;
  for (let n = 0; ; n++) {
    try {
      return await attempt(Math.max(1, deadline - now()));
    } catch (error) {
      const asked = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0;
      const wait = Math.min(maxWaitMs, Math.max(minWaitMs, asked));
      const left = deadline - now() - wait;
      if (!repeatable(method, error) || n >= retries || left <= 0 || left < floor)
        throw error;
      if (signal?.aborted) throw error;
      try {
        await sleep(wait, undefined, signal ? { signal } : undefined);
      } catch {
        throw error;
      }
      if (!current()) throw error;
    }
  }
}
