import { contractTimeout } from "./contract-timeout.js";

// How long the browser tool's `start` may take. OpenClaw 2026.11.3 gives the request
// 15 s, but a cold start of a managed profile (dist chrome-*.mjs launchOpenClawChrome)
// first runs a bootstrap Chrome until "Local State" and "Default/Preferences" exist
// (CHROME_BOOTSTRAP_PREFS_TIMEOUT_MS, 10 s; on Linux Chrome writes its preferences
// later, so the bootstrap always takes all of it), stops it (5 s after SIGTERM, 5 s
// after SIGKILL), then waits up to 15 s for the real launch's CDP port and 8 s for
// its websocket: 43 s at most. With 15 s a cold
// start on a loaded GitHub runner (about 12 s) answered "timed out" while the launch
// went on, and the repeated `start` only joined that same launch: OpenClaw coalesces
// starts of one profile (enqueueProfileStart), so it never launched Chrome again.
export const browserStartTimeoutMs = 50000;
export const startArguments = Object.freeze({
  action: "start",
  timeoutMs: browserStartTimeoutMs,
});

// How long a turn calling `start` may run, the bound of its agent.wait. The run ends by
// itself within the tool's own deadlines: OpenClaw's `start` sends the start request
// and then a status request, each with the call's timeoutMs (browser-tool.lifecycle,
// 2026.11.3), and the turn asks the model before and after the call. A turn wait of
// 60 s left 10 s beside the start request's 50 s; a loaded ubuntu-latest runner used
// them up and the turn read as "timeout" (AGENTPIER-458). agent.wait answers when the
// run ends, so a start that comes up waits no longer than before.
export const browserStartTurnMs = contractTimeout(2 * browserStartTimeoutMs + 20000);

// A start that did not bring the browser up: the request ran out of time ("timed out
// … Retry the browser tool once"), or the launch's Chrome never opened its CDP port
// ("Failed to start Chrome CDP on port …", seen on ubuntu-latest runners with at most
// one line of Chrome output). The launch then ended and its profile is bootstrapped,
// so the next `start` is a new launch of just the browser.
export const startFailed = (result) =>
  /"status": "error"[\s\S]*(?:timed out\.|Failed to start Chrome CDP)/.test(result ?? "");

/**
 * Starts the browser through `start(label, args, { waitMs })` (one agent turn calling
 * the browser tool with `args` and waiting `waitMs` for the run's end, answering
 * `{ result }`) and starts it once more after a failed start. Returns the first
 * answer, or the second's.
 */
export async function startBrowser(start) {
  const turn = { waitMs: browserStartTurnMs };
  const first = await start("start", startArguments, turn);
  // A bare string answer would hide every failure from the second start.
  if (typeof first !== "object" || first === null || !("result" in first))
    throw TypeError("The browser start must answer { result }.");
  return startFailed(first.result)
    ? await start("start-retry", startArguments, turn)
    : first;
}
