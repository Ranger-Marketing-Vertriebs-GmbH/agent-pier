import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { setup } from "../helpers/mcp-pipeline-fixture.js";
import { openLive } from "../helpers/live-socket.js";
import { signedInUser } from "../helpers/users.js";

// A run parked at a human gate.
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

async function subscribed(f, topic) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic });
  const snapshot = await live.next((frame) => frame.topic === topic, 5000);
  assert.equal(snapshot.type, "snapshot");
  return { live, snapshot };
}

test("the run snapshot equals GET /api/pipeline-runs/<id>", async (t) => {
  const f = await applicationFixture(t);
  f.application.pipelines.store.create(structuredClone(waitingRun));
  const { live, snapshot } = await subscribed(f, "pipeline.run:run-waiting");
  const body = await (await f.request("/api/pipeline-runs/run-waiting")).json();
  assert.deepEqual(snapshot.data, body);
  assert.equal(snapshot.data.run.status, "awaiting-human");
  live.ws.close();
});

test("a gate decision pushes the run within 1 s", async (t) => {
  const f = await applicationFixture(t);
  f.application.pipelines.store.create(structuredClone(waitingRun));
  const topic = "pipeline.run:run-waiting";
  const { live } = await subscribed(f, topic);
  const started = Date.now();
  const response = await f.request("/api/pipeline-runs/run-waiting/gate", {
    method: "POST",
    body: { action: "accept" },
  });
  assert.equal(response.status, 200);
  const frame = await live.next(
    (item) => item.topic === topic && item.data?.run?.status !== "awaiting-human",
    1000,
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(frame.type, "state");
  const body = await (await f.request("/api/pipeline-runs/run-waiting")).json();
  assert.equal(frame.data.run.status, body.run.status);
  live.ws.close();
});

test("a missing run answers { run: null }, and so does a deleted one", async (t) => {
  const f = await applicationFixture(t);
  const missing = await subscribed(f, "pipeline.run:run-missing");
  assert.deepEqual(missing.snapshot.data, { run: null });
  missing.live.ws.close();
  f.application.pipelines.store.create({
    ...structuredClone(waitingRun),
    status: "failed",
  });
  const topic = "pipeline.run:run-waiting";
  const { live, snapshot } = await subscribed(f, topic);
  assert.equal(snapshot.data.run.status, "failed");
  const removed = await f.request("/api/pipeline-runs/run-waiting", { method: "DELETE" });
  assert.ok(removed.status < 300);
  const frame = await live.next((item) => item.topic === topic, 1000);
  assert.deepEqual(frame, { ...frame, type: "state", data: { run: null } });
  live.ws.close();
});

test("a queued item pushes the queue, which equals GET /api/pipeline-queue/<id>", async (t) => {
  const c = await setup(t);
  // Keeps the project's only slot busy, so the new item stays queued.
  await c.services.pipelines.start({
    pipelineId: c.pipeline.id,
    cwd: c.app.project,
    task: "Busy",
  });
  const base = `/api/pipeline-queue/${c.project.id}`;
  const topic = `pipeline.queue:${c.project.id}`;
  const { live, snapshot } = await subscribed(c.app, topic);
  assert.deepEqual(snapshot.data, await (await c.app.request(base)).json());
  const started = Date.now();
  const added = await c.app.request(`${base}/items`, {
    method: "POST",
    body: { pipelineId: c.pipeline.id, task: "Queued" },
  });
  assert.equal(added.status, 201);
  const { item } = await added.json();
  const frame = await live.next(
    (next) => next.topic === topic && next.data?.items?.some((i) => i.id === item.id),
    1000,
  );
  assert.ok(Date.now() - started < 1000);
  assert.equal(frame.type, "state");
  assert.deepEqual(frame.data, await (await c.app.request(base)).json());
  live.ws.close();
});

test("a started item's run status reaches the queue", async (t) => {
  const c = await setup(t);
  const base = `/api/pipeline-queue/${c.project.id}`;
  const topic = `pipeline.queue:${c.project.id}`;
  const { item } = await (
    await c.app.request(`${base}/items`, {
      method: "POST",
      body: { pipelineId: c.pipeline.id, task: "Started" },
    })
  ).json();
  await c.services.pipelineQueue.changed();
  const { live, snapshot } = await subscribed(c.app, topic);
  assert.equal(snapshot.data.items[0].run.status, "running");
  // The queue itself does not change: only the run it shows does.
  await c.services.pipelines.cancel(item.id);
  const frame = await live.next(
    (next) => next.topic === topic && next.data?.items?.[0]?.run?.status !== "running",
    1000,
  );
  assert.equal(frame.data.items[0].run.status, "cancelled");
  live.ws.close();
});

test("restricted users cannot subscribe to runs or queues", async (t) => {
  const f = await applicationFixture(t);
  f.application.pipelines.store.create(structuredClone(waitingRun));
  const { cookie } = await signedInUser(f);
  const live = openLive(f, cookie);
  await live.next((frame) => frame.type === "hello");
  for (const topic of ["pipeline.run:run-waiting", "pipeline.queue:any-project"]) {
    live.send({ op: "sub", topic });
    assert.deepEqual(await live.next((frame) => frame.topic === topic), {
      type: "error",
      topic,
      code: "unknown-topic",
    });
  }
  live.ws.close();
});

test("items moved to another project leave the old project's queue", async (t) => {
  const c = await setup(t);
  const from = `pipeline.queue:${c.other.id}`;
  const { live } = await subscribed(c.app, from);
  const added = await c.app.request(`/api/pipeline-queue/${c.other.id}/items`, {
    method: "POST",
    body: { pipelineId: c.pipeline.id, task: "Moving" },
  });
  assert.equal(added.status, 201);
  await live.next((frame) => frame.topic === from && frame.data?.items?.length === 1);
  c.services.pipelineQueue.moveProject(c.other.id, c.project.id);
  const frame = await live.next((next) => next.topic === from, 1000);
  assert.deepEqual(frame.data.items, []);
  live.ws.close();
});

test("a removed project's queue says so instead of showing the old queue", async (t) => {
  const c = await setup(t);
  const topic = `pipeline.queue:${c.other.id}`;
  const { live, snapshot } = await subscribed(c.app, topic);
  assert.equal(snapshot.data.projectId, c.other.id);
  assert.equal(c.services.memory.removeEmpty(c.other.id), true);
  // The tab reads the route, which refuses the project.
  assert.deepEqual(await live.next((frame) => frame.topic === topic, 5000), {
    type: "error",
    topic,
  });
  assert.equal((await c.app.request(`/api/pipeline-queue/${c.other.id}`)).status, 404);
  live.ws.close();
});

test("a refused topic read is not logged, a failing one is", async (t) => {
  const f = await applicationFixture(t);
  const logged = t.mock.method(console, "error", () => {});
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  const missing = "pipeline.queue:missing-project";
  live.send({ op: "sub", topic: missing });
  assert.equal((await live.next((frame) => frame.topic === missing)).type, "error");
  assert.equal(logged.mock.callCount(), 0);
  f.application.pipelines.get = () => {
    throw new Error("disk failure");
  };
  const broken = "pipeline.run:run-broken";
  live.send({ op: "sub", topic: broken });
  assert.equal((await live.next((frame) => frame.topic === broken)).type, "error");
  assert.deepEqual(logged.mock.calls.at(-1).arguments, [
    `AgentPier could not update the live topic ${broken}.`,
  ]);
  live.ws.close();
});

test("a run of several hundred KiB is pushed, not sent as stale", async (t) => {
  const f = await applicationFixture(t);
  const finding = { severity: "high", title: "t".repeat(120), detail: "d".repeat(600) };
  const verdict = { result: "fail", summary: "s".repeat(400), findings: [] };
  verdict.findings = Array.from({ length: 10 }, () => finding);
  const run = {
    ...structuredClone(waitingRun),
    executionLog: Array.from({ length: 60 }, (_, i) => ({
      id: `turn-${i}`,
      nodeId: "gate",
      status: "passed",
      verdict,
    })),
  };
  f.application.pipelines.store.create(run);
  const topic = "pipeline.run:run-waiting";
  const { live, snapshot } = await subscribed(f, topic);
  const size = Buffer.byteLength(JSON.stringify(snapshot));
  assert.ok(size > 256 * 1024 && size < 1024 * 1024, `${size} bytes`);
  assert.equal(snapshot.data.run.executionLog.length, 60);
  live.ws.close();
});
