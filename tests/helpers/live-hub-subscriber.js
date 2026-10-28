// A subscriber of a LiveHub topic for integration tests: it keeps every frame and
// waits for the next one that matches.
import { setTimeout as delay } from "node:timers/promises";

export const owner = { role: "owner" };

/** Subscribes `principal` to `topicId`; returns `{ frames, next(predicate, ms), stop }`. */
export function subscribe(hub, topicId, principal = owner) {
  const frames = [];
  const waiters = [];
  const stop = hub.subscribe(principal, topicId, undefined, (frame) => {
    frames.push(frame);
    for (const waiter of [...waiters])
      if (waiter.predicate(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
  });
  const next = (predicate = () => true, timeout = 2000) => {
    const found = frames.find((frame) => !frame.taken && predicate(frame));
    if (found) {
      found.taken = true;
      return Promise.resolve(found);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no frame")), timeout);
      waiters.push({
        predicate,
        resolve: (frame) => {
          clearTimeout(timer);
          frame.taken = true;
          resolve(frame);
        },
      });
    });
  };
  return { frames, next, stop };
}

/** Resolves once `predicate()` holds; rejects after `timeout` ms. */
export async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error("condition not reached");
    await delay(5);
  }
}
