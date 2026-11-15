import { setTimeout as delay } from "node:timers/promises";

// OpenClaw answers a call that did nothing and may be repeated with a retryable
// UNAVAILABLE, often with the wait it asks for: a models.list that a newer catalog
// generation superseded (2026.11.2), or a call that reads an agent database still
// being inspected in the background (`agent-database-inspection-pending`, 250 ms).
// Such an answer is asked again a few times, after at least `minWaitMs` (never in a
// tight loop) and at most `maxWaitMs`, within `deadline`.
export const retryableAnswer = (error) =>
  error?.answered === true && error.retryable === true;

/**
 * Runs `call` and repeats it after a retryable answer, at most `retries` times and
 * never past `deadline` (ms since the epoch). Any other failure throws at once.
 */
export async function retryingCall(
  call,
  {
    retries = 5,
    minWaitMs = 250,
    maxWaitMs = 2000,
    deadline = Infinity,
    sleep = delay,
    now = Date.now,
  } = {},
) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const asked = Number.isFinite(error?.retryAfterMs) ? error.retryAfterMs : 0;
      const wait = Math.min(maxWaitMs, Math.max(minWaitMs, asked));
      if (!retryableAnswer(error) || attempt >= retries || now() + wait >= deadline)
        throw error;
      await sleep(wait);
    }
  }
}
