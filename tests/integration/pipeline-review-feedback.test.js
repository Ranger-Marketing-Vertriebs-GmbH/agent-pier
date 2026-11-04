import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "../helpers/pipeline-engine.js";
import { groupFixture, pass } from "../helpers/pipeline-group.js";
import { parseGitDiff } from "../../server/features/changes/diff-parse.js";
import { anchorAt } from "../../server/features/changes/review-anchor.js";
import { commentInput } from "../../server/features/changes/review-comment-input.js";
import { ReviewCommentStore } from "../../server/features/changes/review-comment-store.js";

const fixtureDiff = [
  "diff --git a/server/a.js b/server/a.js",
  "index 1111111..2222222 100644",
  "--- a/server/a.js",
  "+++ b/server/a.js",
  "@@ -40,3 +40,3 @@ function login() {",
  " const user = load();",
  "-if (pw === user.pw) return ok();",
  "+if (await verify(pw, user.hash)) return ok();",
  " return fail();",
].join("\n");
const otherDiff = [
  "diff --git a/server/b.js b/server/b.js",
  "index 1111111..2222222 100644",
  "--- a/server/b.js",
  "+++ b/server/b.js",
  "@@ -1,1 +1,1 @@",
  "-old",
  "+new",
].join("\n");
const rows = parseGitDiff(fixtureDiff)[0].rows;

// Wires a review comment store and a whole-run diff into a fixture's engine.
function withReview(f, diff = fixtureDiff) {
  const store = new ReviewCommentStore({ dataDir: f.dir });
  f.workspace.runDiff = async () => ({
    from: "base",
    files: parseGitDiff(diff),
    truncated: false,
  });
  return store;
}
// The engine is built before the store exists: hand it a store that forwards.
const options = (box) => ({
  reviewComments: {
    list: (scope) => box.store.list(scope),
    markSent: (scope, ids) => box.store.markSent(scope, ids),
  },
});
function comment(store, run, body = "Check this.", index = 3) {
  const input = {
    file: "server/a.js",
    side: "new",
    line: 41,
    anchor: anchorAt(rows, index),
  };
  return store.create(
    { kind: "run", id: run.id },
    commentInput({ ...input, body }, { kind: "run" }),
  );
}

// A run parked at a human gate after its first stage, with a native session.
async function gated(t, diff) {
  const box = {};
  const f = fixture(t, { gate: true, options: options(box) });
  box.store = withReview(f, diff);
  const run = await f.engine.start({
    pipelineId: "definition",
    cwd: f.dir,
    task: "Task",
  });
  await f.end(undefined, { nativeId: "native" });
  assert.equal(f.engine.get(run.id).status, "awaiting-human");
  return { f, run, store: box.store, scope: { kind: "run", id: run.id } };
}

// build -> test -> review -> gate, a review failure loops back to build.
async function looped(t) {
  const box = {};
  const f = fixture(t, { options: options(box) });
  box.store = withReview(f);
  const original = f.definitions.snapshot;
  f.definitions.snapshot = () => {
    const snapshot = original();
    snapshot.pipeline.graph = {
      entry: "build",
      nodes: ["build", "test", "review", "gate"].map((id) => ({
        id,
        kind: id === "gate" ? "gate" : "profile",
        profileId: "profile",
      })),
      edges: [
        { from: "build", to: "test", condition: "default" },
        { from: "test", to: "review", condition: "default" },
        { from: "review", to: "gate", condition: "pass" },
        { from: "review", to: "build", condition: "fail", maxIterations: 2 },
      ],
    };
    return snapshot;
  };
  const run = await f.engine.start({ pipelineId: "definition", cwd: f.dir, task: "Fix" });
  for (const summary of ["Built", "Tested", "Reviewed"]) await f.end(pass(summary));
  assert.equal(f.engine.get(run.id).status, "awaiting-human");
  return { f, run, store: box.store };
}

test("Retry with feedback sends free text and the batch to the stage", async (t) => {
  const { f, run, store } = await gated(t);
  comment(store, run, "Use a constant-time comparison.");
  comment(store, run, "Name the helper.", 4);
  await f.engine.gate(run.id, {
    action: "feedback",
    feedback: "Also fix the tests.",
    review: true,
  });
  const prompt = f.launches.at(-1).prompt;
  assert.match(
    prompt,
    /Operator or verification feedback:\n\nAlso fix the tests\.\n\nReview notes \(2\):/,
  );
  // run comments carry no workspace: their paths are relative to the run's workspace
  assert.match(prompt, /^1\. server\/a\.js:41$/m);
  assert.match(prompt, /^2\. server\/a\.js:42$/m);
});

test("Retry with feedback works with the batch alone", async (t) => {
  const { f, run, store } = await gated(t);
  comment(store, run);
  await f.engine.gate(run.id, { action: "feedback", review: true });
  assert.match(
    f.launches.at(-1).prompt,
    /Operator or verification feedback:\n\nReview notes \(1\):/,
  );
});

test("Return for repair puts the batch into the round's operator note", async (t) => {
  const { f, run, store } = await looped(t);
  comment(store, run);
  comment(store, run, "Second note.", 4);
  await f.engine.gate(run.id, { action: "loop-back", review: true });
  const round = f.engine.get(run.id).loopRounds.at(-1);
  assert.match(round.operatorNote, /^Review notes \(2\):/);
  assert.match(f.launches.at(-1).prompt, /Review notes \(2\):/);
});

test("Return for repair puts the free text before the batch", async (t) => {
  const { f, run, store } = await looped(t);
  comment(store, run);
  await f.engine.gate(run.id, {
    action: "loop-back",
    feedback: "Docs too.",
    review: true,
  });
  const note = f.engine.get(run.id).loopRounds.at(-1).operatorNote;
  assert.match(note, /^Docs too\.\n\nReview notes \(1\):/);
});

test("sent comments name the batch and stay open", async (t) => {
  const { f, run, store, scope } = await gated(t);
  comment(store, run);
  comment(store, run, "Second note.", 4);
  await f.engine.gate(run.id, { action: "feedback", review: true });
  assert.deepEqual(
    store.list(scope).comments.map((c) => [c.status, c.sentIn]),
    [
      ["open", 1],
      ["open", 1],
    ],
  );
  assert.equal(store.list(scope).batches, 1);
});

test("resolved comments stay out of the batch", async (t) => {
  const { f, run, store, scope } = await gated(t);
  comment(store, run);
  const done = comment(store, run, "Already handled.", 4);
  store.update(scope, done.id, { status: "resolved" });
  await f.engine.gate(run.id, { action: "feedback", review: true });
  assert.match(f.launches.at(-1).prompt, /Review notes \(1\):/);
  assert.doesNotMatch(f.launches.at(-1).prompt, /Already handled/);
  assert.equal(store.list(scope).comments.find((c) => c.id === done.id).sentIn, null);
});

test("outdated comments still go into the batch", async (t) => {
  // the whole-run diff no longer contains the anchored line
  const { f, run, store } = await gated(t, otherDiff);
  comment(store, run);
  await f.engine.gate(run.id, { action: "feedback", review: true });
  assert.match(f.launches.at(-1).prompt, /server\/a\.js:41 \(outdated\)/);
});

test("an unreadable whole-run diff leaves every comment outdated", async (t) => {
  const { f, run, store, scope } = await gated(t);
  f.workspace.runDiff = async () => {
    throw Error("worktree gone");
  };
  comment(store, run);
  await f.engine.gate(run.id, { action: "feedback", review: true });
  assert.match(f.launches.at(-1).prompt, /server\/a\.js:41 \(outdated\)/);
  assert.equal(store.list(scope).comments[0].sentIn, 1);
});

test("the limit is in bytes and nothing launches above it", async (t) => {
  const { f, run, store, scope } = await gated(t);
  // 4 × 8,180 bytes of "ä": under 32,768 characters, above 32,768 bytes with the text
  for (let i = 0; i < 4; i++) comment(store, run, "ä".repeat(4090));
  const before = f.launches.length;
  await assert.rejects(
    f.engine.gate(run.id, {
      action: "feedback",
      feedback: "ä".repeat(100),
      review: true,
    }),
    { status: 409, code: "PIPELINE_FEEDBACK_TOO_LARGE" },
  );
  assert.equal(f.launches.length, before);
  assert.equal(f.engine.get(run.id).status, "awaiting-human");
  assert.ok(store.list(scope).comments.every((c) => c.sentIn === null));
  assert.equal(store.list(scope).batches, 0);
});

test("feedback without comments works as before and opens no batch", async (t) => {
  const { f, run, store, scope } = await gated(t);
  await f.engine.gate(run.id, { action: "feedback", feedback: "Plain.", review: true });
  assert.match(f.launches.at(-1).prompt, /Operator or verification feedback:\n\nPlain\./);
  assert.doesNotMatch(f.launches.at(-1).prompt, /Review notes/);
  assert.equal(store.list(scope).batches, 0);
});

test("without review the open comments stay out of the feedback", async (t) => {
  const { f, run, store, scope } = await gated(t);
  comment(store, run);
  await f.engine.gate(run.id, { action: "feedback", feedback: "Plain." });
  assert.doesNotMatch(f.launches.at(-1).prompt, /Review notes/);
  assert.equal(store.list(scope).comments[0].sentIn, null);
});

test("review on other actions is ignored", async (t) => {
  const { f, run, store, scope } = await gated(t);
  comment(store, run);
  await f.engine.gate(run.id, { action: "accept", review: true });
  assert.equal(f.engine.get(run.id).status, "completed");
  assert.equal(store.list(scope).comments[0].sentIn, null);
  assert.equal(store.list(scope).batches, 0);
});

test("malformed free text is refused as before", async (t) => {
  const { f, run, store, scope } = await gated(t);
  comment(store, run);
  await assert.rejects(
    f.engine.gate(run.id, { action: "feedback", feedback: 42, review: true }),
    { status: 400 },
  );
  assert.equal(store.list(scope).comments[0].sentIn, null);
});

test("a refused action marks nothing sent", async (t) => {
  const { f, run, store, scope } = await gated(t);
  comment(store, run);
  await assert.rejects(
    f.engine.gate(run.id, { action: "loop-back", feedback: "x", review: true }),
    { status: 409 },
  );
  assert.equal(store.list(scope).comments[0].sentIn, null);
});

test("a parallel-group member's feedback carries all open run comments", async (t) => {
  const box = {};
  const { f, finish, start } = groupFixture(t, { loop: false, options: options(box) });
  box.store = withReview(f);
  const run = await start();
  await finish("build", pass("Built"));
  await finish(
    "security",
    { ...pass("Ask"), requiresHuman: true, question: "Is the rotation intended?" },
    { nativeId: "native-security" },
  );
  await finish("code", pass());
  comment(box.store, run);
  comment(box.store, run, "Second note.", 4);
  await f.engine.gate(run.id, {
    action: "feedback",
    nodeId: "security",
    feedback: "Yes.",
    review: true,
  });
  const turn = f.launches.findLast((l) => l.nodeId === "security");
  assert.equal(turn.kind, "gate-feedback");
  assert.match(turn.prompt, /Yes\.\n\nReview notes \(2\):/);
  assert.deepEqual(
    box.store.list({ kind: "run", id: run.id }).comments.map((c) => c.sentIn),
    [1, 1],
  );
});
