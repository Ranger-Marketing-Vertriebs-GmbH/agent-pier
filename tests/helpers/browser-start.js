// OpenClaw's answer when the browser tool's `start` request ran out of its 15 s budget
// while Chrome keeps launching: "timed out … Retry the browser tool once". A cold
// Chrome launch takes about 10 s on Apple silicon and reaches that edge on GitHub's
// ubuntu-latest and Intel macOS runners.
export const startTimedOut = (result) =>
  /"status": "error"[\s\S]*timed out\./.test(result ?? "");

/**
 * Starts the browser through `start` (one agent turn with the browser tool's `start`
 * action, answering `{ result }`) and repeats it once after a timed-out answer, as
 * OpenClaw tells the agent to. Returns the first answer, or the retry's.
 */
export async function startBrowser(start) {
  const first = await start("start");
  // A bare string answer would hide every timeout from the retry.
  if (typeof first !== "object" || first === null || !("result" in first))
    throw TypeError("The browser start must answer { result }.");
  return startTimedOut(first.result) ? await start("start-retry") : first;
}
