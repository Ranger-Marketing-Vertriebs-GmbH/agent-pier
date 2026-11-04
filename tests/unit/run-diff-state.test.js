import test from "node:test";
import assert from "node:assert/strict";
import {
  diffFailure,
  gateWaits,
  keptDiff,
  runDiffKey,
  stageDiff,
} from "../../web/features/pipelines/run-diff-state.js";

const run = (extra = {}) => ({
  id: "run-one",
  status: "running",
  currentNodeId: "plan",
  executionLog: [{ id: "a" }],
  ...extra,
});

test("the run diff is read again when status, stage, attempts or the refresh change", () => {
  const key = runDiffKey(run(), 0);
  assert.equal(runDiffKey(run(), 0), key);
  // other run fields (usage, a spec edit) do not read the diff again
  assert.equal(runDiffKey(run({ usage: { totalTokens: 9 } }), 0), key);
  for (const changed of [
    runDiffKey(run({ status: "awaiting-human" }), 0),
    runDiffKey(run({ currentNodeId: "review" }), 0),
    runDiffKey(run({ executionLog: [{ id: "a" }, { id: "b" }] }), 0),
    runDiffKey(run(), 1),
  ])
    assert.notEqual(changed, key);
  assert.equal(
    runDiffKey(run({ executionLog: undefined }), 0),
    runDiffKey(run({ executionLog: [] }), 0),
  );
});

test("a group member starting to wait reads the diff again", () => {
  const key = runDiffKey(run({ memberActions: {} }), 0);
  assert.equal(runDiffKey(run(), 0), key);
  // an empty list is no waiting member
  assert.equal(runDiffKey(run({ memberActions: { a: [] } }), 0), key);
  const waiting = runDiffKey(run({ memberActions: { a: ["feedback"] } }), 0);
  assert.notEqual(waiting, key);
  // only which members wait counts, not their order or actions
  assert.equal(
    runDiffKey(run({ memberActions: { b: ["retry"], a: ["feedback"] } }), 0),
    runDiffKey(run({ memberActions: { a: ["override"], b: ["feedback"] } }), 0),
  );
});

test("comments are writable only while a decision that carries them waits", () => {
  assert.equal(gateWaits(run({ actions: ["abort", "feedback"] })), true);
  assert.equal(gateWaits(run({ actions: ["loop-back"] })), true);
  assert.equal(gateWaits(run()), false);
  // budget, risk and override-only gates cannot send them
  for (const actions of [
    ["raise-budget", "abort"],
    ["approve-risk", "decline-risk"],
    ["override"],
    ["accept"],
  ])
    assert.equal(gateWaits(run({ actions })), false, actions.join());
  assert.equal(gateWaits(run({ memberActions: { a: [] } })), false);
  assert.equal(gateWaits(run({ memberActions: { a: ["retry", "override"] } })), false);
  assert.equal(gateWaits(run({ memberActions: { a: ["feedback"] } })), true);
  // a member cannot return for repair; loop-back there carries nothing
  assert.equal(gateWaits(run({ memberActions: { a: ["loop-back"] } })), false);
});

test("an answer with the shown fingerprint keeps the shown diff", () => {
  const shown = { files: [{ path: "a.js" }], truncated: false, fingerprint: "f1" };
  const same = { files: [{ path: "a.js" }], truncated: false, fingerprint: "f1" };
  const edited = { files: [{ path: "a.js" }], truncated: false, fingerprint: "f2" };
  assert.equal(keptDiff(shown, same), shown);
  assert.equal(keptDiff(shown, edited), edited);
  assert.equal(keptDiff(null, same), same);
  // without a fingerprint every answer replaces the shown diff
  const plain = { files: [], truncated: false };
  assert.equal(keptDiff({ files: [], truncated: false }, plain), plain);
});

test("a failed read names gone worktrees and imported runs by their codes", () => {
  assert.equal(diffFailure({ status: 409, code: "PIPELINE_RUN_WORKSPACE_GONE" }), "gone");
  assert.equal(diffFailure({ status: 409, code: "PIPELINE_RUN_IMPORTED" }), "imported");
  assert.equal(
    diffFailure({ status: 409, code: "PIPELINE_FEEDBACK_TOO_LARGE" }),
    "error",
  );
  assert.equal(diffFailure({ status: 500 }), "error");
  assert.equal(diffFailure(new Error("offline")), "error");
  assert.equal(diffFailure(undefined), "error");
});

test("a stage's diff text becomes parsed files", () => {
  const text = [
    "diff --git a/src/app.js b/src/app.js",
    "index 1111111..2222222 100644",
    "--- a/src/app.js",
    "+++ b/src/app.js",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old line",
    "+new line",
    "",
  ].join("\n");
  const pane = stageDiff({ diff: text, truncated: true });
  assert.equal(pane.truncated, true);
  assert.equal(pane.files.length, 1);
  assert.equal(pane.files[0].path, "src/app.js");
  assert.deepEqual(
    pane.files[0].rows.filter((row) => row.kind !== "meta").map((row) => row.kind),
    ["context", "remove", "add"],
  );
  assert.deepEqual(stageDiff({}), { files: [], truncated: false });
  assert.deepEqual(stageDiff({ diff: "" }), { files: [], truncated: false });
});
