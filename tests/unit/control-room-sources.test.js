import test from "node:test";
import assert from "node:assert/strict";
import { orderSourceTopics } from "../../web/features/autopilot/order-source-topics.js";

test("the register shares list subscriptions across parallel orders in a project", () => {
  const waiting = {
    projectId: "project-1",
    session: { id: "composer-1" },
    startReceipts: [{ runId: "a", queueState: "queued" }],
    runs: [{ id: "a", resolution: "unavailable" }],
  };
  const second = { ...waiting, session: { id: "composer-2" } };
  assert.deepEqual(orderSourceTopics([waiting, second], false), [
    "inbox",
    "pipeline.queue:project-1",
    "pipeline.runs.changed",
  ]);
  assert.deepEqual(
    orderSourceTopics([{ ...second, runs: [{ id: "b", resolution: "live" }] }], true),
    [
      "pipeline.queue:project-1",
      "pipeline.run:b",
      "pipeline.runs.changed:project-1",
      "session.requests:composer-2",
    ],
  );
});
