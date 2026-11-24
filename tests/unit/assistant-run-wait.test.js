import test from "node:test";
import assert from "node:assert/strict";
import { waitForRun } from "../helpers/assistant-run-wait.js";

// AGENTPIER-493: OpenClaw 2026.11.6 answers `agent.wait` for a queued turn at once
// with "pending"; the native contracts must not take that for the run's end.
const queued = {
  runId: "r",
  status: "pending",
  timeoutPhase: "queue",
  providerStarted: false,
};

test("a queued run is waited on until it has ended", async () => {
  const answers = [queued, queued, { runId: "r", status: "ok" }];
  const calls = [];
  const client = {
    call: async (method, params) => {
      calls.push([method, params.runId]);
      return answers.shift();
    },
  };
  const waited = await waitForRun(client, "r");
  assert.deepEqual(waited, { runId: "r", status: "ok" });
  assert.deepEqual(calls, [
    ["agent.wait", "r"],
    ["agent.wait", "r"],
    ["agent.wait", "r"],
  ]);
});

test("a failed run ends the wait, and a run still queued past the time is returned", async () => {
  const failed = { runId: "r", status: "error", error: "boom" };
  assert.deepEqual(await waitForRun({ call: async () => failed }, "r"), failed);
  assert.deepEqual(
    await waitForRun({ call: async () => queued }, "r", { timeoutMs: 300 }),
    queued,
  );
});
