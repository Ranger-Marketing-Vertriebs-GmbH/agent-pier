// How long the browser tool's `start` may take. OpenClaw 2026.11.3 gives the request
// 15 s, but a cold start of a managed profile (dist chrome-*.mjs launchOpenClawChrome)
// first runs a bootstrap Chrome until "Local State" and "Default/Preferences" exist
// (CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS, 10 s; on Linux Chrome writes its preferences
// later, so the bootstrap always takes all of it), stops it (5 s after SIGTERM, 5 s
// after SIGKILL), then waits up to 15 s for the real launch's CDP port and 8 s for
// its websocket: 43 s at most, within a turn's 60 s agent.wait. With 15 s a cold
// start on a loaded GitHub runner (about 12 s) answered "timed out" while the launch
// went on, and the repeated `start` only joined that same launch: OpenClaw coalesces
// starts of one profile (enqueueProfileStart), so it never launched Chrome again.
export const browserStartTimeoutMs = 50000;
export const startArguments = Object.freeze({
  action: "start",
  timeoutMs: browserStartTimeoutMs,
});

// A start that did not bring the browser up: the request ran out of time ("timed out
// … Retry the browser tool once"), or the launch's Chrome never opened its CDP port
// ("Failed to start Chrome CDP on port …", seen on ubuntu-latest runners with at most
// one line of Chrome output). The launch then ended and its profile is bootstrapped,
// so the next `start` is a new launch of just the browser.
export const startFailed = (result) =>
  /"status": "error"[\s\S]*(?:timed out\.|Failed to start Chrome CDP)/.test(result ?? "");

/**
 * Starts the browser through `start(label, args)` (one agent turn calling the browser
 * tool with `args`, answering `{ result }`) and starts it once more after a failed
 * start. Returns the first answer, or the second's.
 */
export async function startBrowser(start) {
  const first = await start("start", startArguments);
  // A bare string answer would hide every failure from the second start.
  if (typeof first !== "object" || first === null || !("result" in first))
    throw TypeError("The browser start must answer { result }.");
  return startFailed(first.result) ? await start("start-retry", startArguments) : first;
}
