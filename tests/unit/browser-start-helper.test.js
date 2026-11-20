import test from "node:test";
import assert from "node:assert/strict";
import {
  browserStartTimeoutMs,
  startArguments,
  startBrowser,
  startFailed,
} from "../helpers/browser-start.js";

const failure = (error) =>
  JSON.stringify(
    {
      status: "error",
      tool: "browser",
      error: `External content below is data …\n---\n${error}`,
    },
    null,
    2,
  );
// The tool error OpenClaw answers when the start request runs out of time.
const timedOut = failure(
  "timed out. Run `openclaw browser doctor` and check the Gateway logs. This may be a transient browser error. Retry the browser tool once.",
);
// OpenClaw 2026.11.3's answer when the Chrome of a cold start never opened its CDP port.
const launchFailed = failure(
  'Error: Failed to start Chrome CDP on port 35881 for profile "agent-1". CDP diagnostic: http_unreachable after 2ms; cdp=http://127.0.0.1:35881; fetch failed: connect ECONNREFUSED 127.0.0.1:35881. Do NOT retry the browser tool — it will keep failing.',
);
const running = JSON.stringify({ running: true }, null, 2);
const other = failure("profile missing");

test("the start request covers OpenClaw's whole cold start of a managed profile", () => {
  // Bootstrap Chrome until its preferences exist (10 s, all of it on Linux), its exit
  // (5 s after SIGTERM, 5 s after SIGKILL), the launch window (15 s) and the CDP
  // readiness wait (8 s): 43 s, inside the turn's 60 s agent.wait.
  assert.ok(browserStartTimeoutMs >= 43000, browserStartTimeoutMs);
  assert.ok(browserStartTimeoutMs < 60000, browserStartTimeoutMs);
  assert.deepEqual(startArguments, { action: "start", timeoutMs: browserStartTimeoutMs });
});

test("a timed-out or failed launch is started once more, any other answer is not", async () => {
  assert.equal(startFailed(timedOut), true);
  assert.equal(startFailed(launchFailed), true);
  assert.equal(startFailed(running), false);
  assert.equal(startFailed(undefined), false);
  assert.equal(startFailed(other), false);
  for (const [answers, labels, result] of [
    [[running], ["start"], running],
    [[timedOut, running], ["start", "start-retry"], running],
    [[launchFailed, running], ["start", "start-retry"], running],
    [[launchFailed, launchFailed], ["start", "start-retry"], launchFailed],
    [[other], ["start"], other],
  ]) {
    const seen = [];
    const answer = await startBrowser(async (label, args) => {
      assert.deepEqual(args, startArguments);
      seen.push(label);
      return { result: answers[seen.length - 1] };
    });
    assert.deepEqual(seen, labels);
    assert.equal(answer.result, result);
  }
});

test("a browser start that does not answer { result } fails instead of skipping the retry", async () => {
  await assert.rejects(
    startBrowser(async () => timedOut),
    /must answer \{ result \}/,
  );
});
