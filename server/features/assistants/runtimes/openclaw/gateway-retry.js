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
// A config.patch over the control-plane budget (no such reason) keeps its own wait
// in live-patch.js. Each repeat waits what the Gateway asks, at least `minWaitMs`
// and at most `maxWaitMs`, and every attempt shares the caller's timeout.
const beforeDispatch = new Set(["gateway-restarting", "gateway-suspending"]);
export const repeatableReads = new Set([
  "models.list",
  "models.authStatus",
  "models.probe",
]);

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
 */
export async function repeating(
  method,
  attempt,
  {
    timeoutMs,
    retries = 10,
    minWaitMs = 250,
    maxWaitMs = 2000,
    sleep = delay,
    now = Date.now,
  },
) {
  const deadline = now() + timeoutMs;
  for (let n = 0; ; n++) {
    try {
      return await attempt(Math.max(1, deadline - now()));
    } catch (error) {
      const asked = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0;
      const wait = Math.min(maxWaitMs, Math.max(minWaitMs, asked));
      if (!repeatable(method, error) || n >= retries || now() + wait >= deadline)
        throw error;
      await sleep(wait);
    }
  }
}
