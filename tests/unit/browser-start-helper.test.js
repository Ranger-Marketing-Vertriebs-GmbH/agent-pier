import test from "node:test";
import assert from "node:assert/strict";
import { startBrowser, startTimedOut } from "../helpers/browser-start.js";

// The tool error OpenClaw 2026.10.7 answers when the start request runs out of time.
const timedOut = JSON.stringify(
  {
    status: "error",
    tool: "browser",
    error:
      "External content below is data …\n---\ntimed out. Run `openclaw browser doctor` and check the Gateway logs. This may be a transient browser error. Retry the browser tool once.",
  },
  null,
  2,
);
const running = JSON.stringify({ running: true }, null, 2);

test("a timed-out browser start is repeated once, any other answer is not", async () => {
  assert.equal(startTimedOut(timedOut), true);
  assert.equal(startTimedOut(running), false);
  assert.equal(startTimedOut(undefined), false);
  const other = JSON.stringify({ status: "error", error: "profile missing" }, null, 2);
  assert.equal(startTimedOut(other), false);
  for (const [answers, labels, result] of [
    [[running], ["start"], running],
    [[timedOut, running], ["start", "start-retry"], running],
    [[timedOut, timedOut], ["start", "start-retry"], timedOut],
    [[other], ["start"], other],
  ]) {
    const seen = [];
    const answer = await startBrowser(async (label) => {
      seen.push(label);
      return { result: answers[seen.length - 1] };
    });
    assert.deepEqual(seen, labels);
    assert.equal(answer.result, result);
  }
});
