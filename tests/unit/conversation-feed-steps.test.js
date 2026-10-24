import test from "node:test";
import assert from "node:assert/strict";
import { ConversationFeeds } from "../../server/features/assistants/conversation-feeds.js";

const history = { messages: [], requests: [], queued: null, nextBefore: null };
const view = (phase, extra = {}) => ({
  steps: [{ id: "tool:c1", kind: "tool", tool: "exec", label: "", state: "running" }],
  omitted: 0,
  phase,
  retry: null,
  quietMs: 0,
  ...extra,
});

function feeds(t, options = {}) {
  const value = new ConversationFeeds({
    read: async () => structuredClone(history),
    scope: (id) => [id, `session:${id}`, "g1"],
    debounceMs: 5,
    recoveryMs: 60000,
    ...options,
  });
  t.after(() => value.close());
  return value;
}
const listen = (feed, id, options = {}) => {
  const frames = [];
  feed.subscribe(id, options, (f) => frames.push(f));
  return () => frames.filter((f) => f.type.startsWith("steps"));
};

test("a running turn's steps reach every viewer, also one who joins later", (t) => {
  const feed = feeds(t);
  const first = listen(feed, "a");
  feed.steps("a", "r1", view("tool"));
  feed.steps("b", "r1", view("tool"));
  // The quiet time counts on from the call, so a slow runner may add a millisecond.
  const [sent] = first();
  assert.equal(first().length, 1);
  assert.ok(sent.quietMs >= 0 && sent.quietMs < 1000);
  assert.deepEqual(
    { ...sent, quietMs: 0 },
    { type: "steps", runId: "r1", ...view("tool") },
  );
  const late = listen(feed, "a");
  assert.equal(late()[0].phase, "tool");
  assert.equal(late()[0].steps[0].tool, "exec");
  feed.endRun("a", "r1");
  assert.deepEqual(first().at(-1), { type: "steps-end", runId: "r1" });
  // An ended run's steps are not sent to a newcomer.
  assert.deepEqual(listen(feed, "a")(), []);
});

test("a new viewer gets the steps the service already holds", (t) => {
  const feed = feeds(t, { steps: () => [["r9", view("model", { quietMs: 61000 })]] });
  const frames = listen(feed, "a");
  assert.equal(frames()[0].runId, "r9");
  assert.ok(frames()[0].quietMs >= 61000);
});

test("the owner reading under her opt-in sees only the steps of what she wrote since", (t) => {
  const since = "2026-10-21T10:00:00.000Z";
  const requests = {
    old: { id: "q1", writtenAt: "2026-10-21T09:00:00.000Z" },
    new: { id: "q2", writtenAt: "2026-10-21T11:00:00.000Z" },
  };
  const feed = feeds(t, { request: (_id, runId) => requests[runId] || null });
  const owner = listen(feed, "a", { since });
  const user = listen(feed, "a");
  feed.steps("a", "old", view("tool"));
  feed.steps("a", "new", view("tool"));
  feed.steps("a", "unknown", view("tool"));
  assert.deepEqual(
    owner().map((f) => f.runId),
    ["new"],
  );
  assert.deepEqual(
    user().map((f) => f.runId),
    ["old", "new", "unknown"],
  );
});
