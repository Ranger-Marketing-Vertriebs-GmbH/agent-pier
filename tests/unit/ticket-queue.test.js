import test from "node:test";
import assert from "node:assert/strict";
import { PARK_REASONS } from "../../server/features/tickets/sequence-engine.js";
import {
  QUEUE_STATES,
  queueItemActions,
  queueItemPath,
  queueStateTone,
} from "../../web/features/projects/ticket-queue.js";
import * as de from "../../web/lib/i18n/de/ticket-sequences.js";
import * as en from "../../web/lib/i18n/en/ticket-sequences.js";

const item = (state, extra = {}) => ({
  id: "i1",
  source: "github",
  key: "acme/app#7",
  title: "Fix",
  kind: "session",
  state,
  ...extra,
});

test("queueStateTone maps every state to a status tone", () => {
  assert.deepEqual(
    Object.fromEntries(QUEUE_STATES.map((state) => [state, queueStateTone(state)])),
    {
      waiting: "neutral",
      running: "neutral",
      "awaiting-merge": "warning",
      "needs-owner": "error",
      done: "ok",
    },
  );
  assert.equal(queueStateTone("unknown"), "neutral");
});

test("queueItemActions offers what the server accepts per state", () => {
  assert.deepEqual(queueItemActions(item("waiting")), ["done", "remove"]);
  assert.deepEqual(
    queueItemActions(
      item("running", { sessionId: "s1", pr: { number: 3, url: "https://x/pr/3" } }),
    ),
    ["remove", "open-session", "open-pr"],
  );
  assert.deepEqual(
    queueItemActions(item("awaiting-merge", { kind: "pipeline", runId: "r1" })),
    ["open-run"],
  );
  assert.deepEqual(
    queueItemActions(
      item("needs-owner", { sessionId: "s1", pr: { number: 3, url: "https://x/pr/3" } }),
    ),
    ["retry", "done", "remove", "open-session", "open-pr"],
  );
  assert.deepEqual(queueItemActions(item("done", { runId: "r1", kind: "pipeline" })), [
    "remove",
    "open-run",
  ]);
  // Retry only for a parked item; Remove never while it awaits its merge.
  for (const state of QUEUE_STATES) {
    const actions = queueItemActions(item(state));
    assert.equal(actions.includes("retry"), state === "needs-owner", state);
    assert.equal(actions.includes("remove"), state !== "awaiting-merge", state);
  }
  // A pull request link opens only over http(s).
  assert.deepEqual(
    queueItemActions(item("done", { pr: { number: 1, url: "javascript:alert(1)" } })),
    ["remove"],
  );
});

test("queueItemPath encodes the project and the item", () => {
  assert.equal(queueItemPath("m 1"), "/tickets/projects/m%201/queue");
  assert.equal(
    queueItemPath("m1", "a/b", "retry"),
    "/tickets/projects/m1/queue/a%2Fb/retry",
  );
  assert.equal(queueItemPath("m1", "i1"), "/tickets/projects/m1/queue/i1");
});

test("the queue copy names every state and every park reason in both languages", () => {
  for (const catalog of [de, en]) {
    const copy = catalog.ticketQueueCopy;
    for (const state of QUEUE_STATES)
      assert.equal(typeof copy.states[state], "string", state);
    for (const reason of PARK_REASONS)
      assert.ok(copy.reasons[reason]?.length > 0, `reason ${reason}`);
    assert.ok(copy.reasons.other.length > 0);
  }
  assert.deepEqual(
    Object.keys(en.ticketQueueCopy.reasons).sort(),
    [...PARK_REASONS, "other"].sort(),
  );
});
