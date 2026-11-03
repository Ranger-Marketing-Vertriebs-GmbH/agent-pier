// Why a sequence item waits for the owner (`needsOwner.reason`). The single list the
// web copy (de/en) is checked against.
export const PARK_REASONS = Object.freeze([
  "githubRequired",
  "sourceUnavailable",
  "ticketUnavailable",
  "startFailed",
  "startInterrupted",
  "taskNotDelivered",
  "sessionEnded",
  "runFailed",
  "noPullRequest",
  "prClosed",
  "mergeDisarmed",
  "armRefused",
  "mergeRefused",
  // Task 9: fix attempts and owner limits.
  "idle",
  "failedRounds",
  "forgeUnreachable",
  "repairUnconfigured",
  "repairFailed",
  // A launch or a delivery that did not answer within the step timeout.
  "stepTimedOut",
]);

const TRANSIENT_CODES = new Set(["unavailable", "unreachable", "rateLimited"]);

/**
 * True for a failure that may pass on its own: an unreachable or overloaded forge, a
 * rate limit, an aborted request or a server-side 5xx without a source code.
 */
export function isTransient(error) {
  if (error?.name === "AbortError") return true;
  if (typeof error?.code === "string") return TRANSIENT_CODES.has(error.code);
  return Number.isInteger(error?.status) && error.status >= 500;
}

/** The code of a launch or delivery that did not answer within the step timeout. */
export const STEP_TIMED_OUT = "stepTimedOut";
export const isTimedOut = (error) => error?.code === STEP_TIMED_OUT;

/**
 * `launch` and `chatDelivery.send` of the engine, each bounded by `ms`, so a call that
 * never answers cannot hold its queue's lock forever. A session launched after its
 * call timed out is stopped: its item is already parked, and nobody watches it.
 */
export function timedCalls({ launch, chatDelivery, sessions, ms }) {
  const bounded = (promise, onLate = () => {}) => {
    if (!(ms > 0)) return promise;
    let timer;
    let late = false;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        late = true;
        reject(Object.assign(new Error("step timed out"), { code: STEP_TIMED_OUT }));
      }, ms);
    });
    promise.then(
      (value) => late && onLate(value),
      () => {},
    );
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  };
  return {
    launch: (...args) =>
      bounded(
        Promise.resolve().then(() => launch(...args)),
        (session) =>
          Promise.resolve()
            .then(() => session?.id && sessions?.stop?.(session.id))
            .catch(() => {}),
      ),
    chatDelivery: {
      ...chatDelivery,
      send: (...args) =>
        bounded(Promise.resolve().then(() => chatDelivery.send(...args))),
    },
  };
}
