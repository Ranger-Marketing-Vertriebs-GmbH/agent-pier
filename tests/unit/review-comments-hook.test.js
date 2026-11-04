import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewPath,
  reviewRequests,
  reviewState,
  reviewTopic,
} from "../../web/features/review/review-comment-requests.js";
import { topicInfo } from "../../web/lib/live/live-topics.js";

// The hook (useReviewComments) is React state around these pure parts and
// useLiveTopic; the repo has no DOM test harness for hooks, so they are tested here
// with a fake api, and the hook itself is exercised by the browser suites.
const session = { kind: "session", id: "s 1" };
const run = { kind: "run", id: "r1" };

function recorder(answers = {}) {
  const calls = [];
  const api = async (path, method = "GET", body) => {
    calls.push([method, path, body]);
    return answers[`${method} ${path}`] ?? {};
  };
  return { api, calls };
}

test("a scope follows its topic and reads the route that topic names", () => {
  assert.equal(reviewTopic(session), "session.review:s 1");
  assert.equal(reviewTopic(run), "pipeline.review:r1");
  assert.equal(reviewTopic(null), null);
  for (const scope of [session, run])
    assert.equal(topicInfo(reviewTopic(scope)).path(scope.id), reviewPath(scope));
});

test("load shows comments and batches, tolerating an empty or odd value", () => {
  assert.deepEqual(reviewState(null), { comments: [], batches: 0 });
  assert.deepEqual(reviewState({ comments: "x", batches: 1.5 }), {
    comments: [],
    batches: 0,
  });
  const comments = [{ id: "c1" }];
  assert.deepEqual(reviewState({ comments, batches: 2 }), { comments, batches: 2 });
});

test("add, resolve, delete and mark sent hit the scope's routes", async () => {
  const { api, calls } = recorder({
    "POST /sessions/s%201/review-comments": { id: "c1" },
    "POST /sessions/s%201/review-comments/sent": { batch: 1 },
  });
  const requests = reviewRequests(api, session);
  assert.deepEqual(await requests.create({ body: "x" }), { id: "c1" });
  await requests.update("c1", { status: "resolved" });
  assert.deepEqual(await requests.markSent(["c1"]), { batch: 1 });
  await requests.remove("c1");
  assert.deepEqual(calls, [
    ["POST", "/sessions/s%201/review-comments", { body: "x" }],
    ["PATCH", "/sessions/s%201/review-comments/c1", { status: "resolved" }],
    ["POST", "/sessions/s%201/review-comments/sent", { ids: ["c1"] }],
    ["DELETE", "/sessions/s%201/review-comments/c1", undefined],
  ]);
});

test("run writes go to the pipeline-runs routes", async () => {
  const { api, calls } = recorder();
  await reviewRequests(api, run).create({ body: "x" });
  assert.equal(calls[0][1], "/pipeline-runs/r1/review-comments");
});

test("a refused write rejects", async () => {
  const api = async () => {
    throw new Error("refused");
  };
  await assert.rejects(reviewRequests(api, run).remove("c1"), /refused/);
});
