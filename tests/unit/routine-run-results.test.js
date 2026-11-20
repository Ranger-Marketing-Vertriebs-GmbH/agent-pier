import test from "node:test";
import assert from "node:assert/strict";
import { withRunResults } from "../../server/features/assistants/routine-results.js";

// A routine's run history names what each completed run delivered (AGENTPIER-440 U10).
const run = (runAtMs, extra = {}) => ({ runAtMs, status: "ok", ...extra });
const result = (runAtMs, text, extra = {}) => ({
  id: `job:${runAtMs}`,
  bindingId: "b",
  runAtMs,
  status: "ok",
  text,
  ...extra,
});

test("each completed run gets the result recorded for it", () => {
  const entries = [run(1_000_000, { durationMs: 4000 }), run(2_000_000)];
  const recorded = [result(2_000_000, "second"), result(1_004_500, "first")];
  assert.deepEqual(withRunResults(entries, recorded), [
    run(1_000_000, { durationMs: 4000, result: "first" }),
    run(2_000_000, { result: "second" }),
  ]);
});

test("a run without a result, a failed one or one far away stays as it is", () => {
  const failed = { runAtMs: 1000, status: "error", failure: { reason: "model" } };
  const lonely = run(10_000_000);
  const entries = [failed, lonely];
  const recorded = [
    result(1000, "text of a failed run"),
    result(10_000_000 + 10 * 60_000, "much later"),
    result(10_000_000, "", { status: "ok" }),
    result(10_000_000, "error text", { status: "error" }),
  ];
  assert.deepEqual(withRunResults(entries, recorded), [failed, lonely]);
});

test("a result goes to one run only, and a long one is cut", () => {
  const long = "x".repeat(400);
  const [first, second] = withRunResults([run(5000), run(6000)], [result(5500, long)]);
  assert.equal(first.result.length, 280);
  assert.ok(first.result.endsWith("…"));
  assert.equal(first.resultCut, true);
  assert.equal(second.result, undefined);
});
