import test from "node:test";
import assert from "node:assert/strict";
import {
  afterWrite,
  reviewPath,
  reviewRequests,
  reviewState,
  reviewTopic,
} from "../../web/features/review/review-comment-requests.js";
import { startLiveTopic } from "../../web/lib/live/live-topic-reader.js";
import { fakeEnv } from "../helpers/fake-browser.js";
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

test("a write resolves with its answer only after written() resolves", async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const result = afterWrite(
    async () => {
      order.push("write");
      return { id: "c1" };
    },
    async () => {
      order.push("written");
      await gate;
      order.push("shown");
    },
  ).then((answer) => {
    order.push("returned");
    return answer;
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["write", "written"]);
  release();
  assert.deepEqual(await result, { id: "c1" });
  assert.deepEqual(order, ["write", "written", "shown", "returned"]);
});

test("a refused write never waits for written()", async () => {
  let waited = false;
  await assert.rejects(
    afterWrite(
      async () => {
        throw new Error("refused");
      },
      async () => {
        waited = true;
      },
    ),
    /refused/,
  );
  assert.equal(waited, false);
});

test("a pushed review state shows its comments and written() resolves with the push", async () => {
  const listeners = new Set();
  const client = {
    subscribe: (_id, listener) => (
      listeners.add(listener),
      () => listeners.delete(listener)
    ),
    status: () => ({ connected: true, fallback: false }),
    emit: (event) => [...listeners].forEach((listener) => listener(event)),
  };
  let shown = null;
  const started = startLiveTopic({
    topicId: "session.review:s1",
    client,
    env: fakeEnv().env,
    read: async () => ({ comments: [], batches: 0 }),
    report: (state) => (shown = state),
  });
  const first = { comments: [{ id: "c1" }], batches: 0 };
  client.emit({ type: "data", data: first });
  assert.deepEqual(reviewState(shown.data), first);
  // The caller writes, then waits for the change: the next push resolves written().
  const written = started.written();
  const second = { comments: [{ id: "c1" }, { id: "c2" }], batches: 1 };
  client.emit({ type: "data", data: second });
  assert.deepEqual(await written, second);
  assert.deepEqual(reviewState(shown.data), second);
  started.stop();
});
