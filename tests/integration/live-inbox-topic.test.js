import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { signedInUser } from "../helpers/users.js";

const forInbox = (frame) => frame.topic === "inbox";

// A run parked at a human gate, in the store the inbox reads its gates from.
const waitingRun = {
  id: "run-waiting",
  status: "awaiting-human",
  pipelineName: "Release",
  cwd: "/fixture/app",
  currentNodeId: "gate",
  nodes: [{ id: "gate", status: "awaiting-gate", kind: "gate" }],
  edges: [],
  executionLog: [],
  createdAt: "2026-10-17T10:00:00.000Z",
};

async function subscribedInbox(f) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "inbox" });
  const snapshot = await live.next(forInbox, 5000);
  assert.equal(snapshot.type, "snapshot");
  return { live, snapshot };
}

test("the inbox snapshot equals GET /api/inbox", async (t) => {
  const f = await applicationFixture(t);
  f.application.pipelines.store.create(structuredClone(waitingRun));
  const { live, snapshot } = await subscribedInbox(f);
  const body = await (await f.request("/api/inbox")).json();
  assert.deepEqual(snapshot.data, body);
  assert.deepEqual(
    snapshot.data.items.map((item) => [item.type, item.id]),
    [["gate", "run-waiting"]],
  );
  live.ws.close();
});

test("an answered pipeline gate leaves the subscriber's inbox within 1 s", async (t) => {
  const f = await applicationFixture(t);
  f.application.pipelines.store.create(structuredClone(waitingRun));
  const { live, snapshot } = await subscribedInbox(f);
  assert.equal(snapshot.data.counts.gates, 1);
  const started = Date.now();
  const response = await f.request("/api/pipeline-runs/run-waiting/gate", {
    method: "POST",
    body: { action: "accept" },
  });
  assert.equal(response.status, 200);
  const frame = await live.next(forInbox, 1000);
  assert.ok(Date.now() - started < 1000);
  assert.equal(frame.type, "state");
  assert.deepEqual(frame.data.items, []);
  assert.equal(frame.data.counts.gates, 0);
  assert.ok(frame.data.revision > snapshot.data.revision);
  live.ws.close();
});

test("a restricted user cannot subscribe to the inbox", async (t) => {
  const f = await applicationFixture(t);
  const { cookie } = await signedInUser(f);
  const live = openLive(f, cookie);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic: "inbox" });
  assert.deepEqual(await live.next(forInbox), {
    type: "error",
    topic: "inbox",
    code: "unknown-topic",
  });
  live.ws.close();
});
