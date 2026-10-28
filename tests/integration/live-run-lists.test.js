import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";

// Runs of two projects; the store's own create and save are the engine's write path,
// so each one reaches the engine's onChange like a real run step.
const run = (id, projectId, status, minute) => ({
  id,
  status,
  projectId,
  pipelineName: "Release",
  cwd: "/fixture/app",
  currentNodeId: "build",
  nodes: [{ id: "build", status: status === "running" ? "running" : "passed" }],
  edges: [],
  executionLog: [],
  createdAt: `2026-10-17T10:${String(minute).padStart(2, "0")}:00.000Z`,
});

async function seeded(t) {
  const f = await applicationFixture(t);
  const { store } = f.application.pipelines;
  store.create(run("run-a", "project-one", "running", 1));
  store.create(run("run-b", "project-one", "failed", 2));
  store.create(run("run-c", "project-two", "running", 3));
  return { f, store };
}

async function listening(f, ...topics) {
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  const first = {};
  for (const topic of topics) {
    live.send({ op: "sub", topic });
    first[topic] = await live.next((frame) => frame.topic === topic, 5000);
  }
  return { live, first };
}

const json = async (f, path) => (await f.request(path)).json();

const finish = (store, id, status = "completed") => {
  const current = store.get(id);
  current.status = status;
  store.save(current);
};

test("counts equal GET /api/pipeline-run-counts, for all runs and one project", async (t) => {
  const { f } = await seeded(t);
  const { live, first } = await listening(
    f,
    "pipeline.counts",
    "pipeline.counts:project-one",
  );
  assert.equal(first["pipeline.counts"].type, "snapshot");
  assert.deepEqual(
    first["pipeline.counts"].data,
    await json(f, "/api/pipeline-run-counts"),
  );
  assert.deepEqual(first["pipeline.counts"].data.counts, {
    running: 2,
    "awaiting-human": 0,
    completed: 0,
    failed: 1,
    cancelled: 0,
  });
  assert.deepEqual(
    first["pipeline.counts:project-one"].data,
    await json(f, "/api/pipeline-run-counts?projectId=project-one"),
  );
  assert.equal(first["pipeline.counts:project-one"].data.counts.running, 1);
  live.ws.close();
});

test("page 1 of each filter equals GET /api/pipeline-runs", async (t) => {
  const { f } = await seeded(t);
  const lists = {
    "pipeline.runs:*:*": "/api/pipeline-runs?page=1",
    "pipeline.runs:project-one:*": "/api/pipeline-runs?page=1&projectId=project-one",
    "pipeline.runs:*:running": "/api/pipeline-runs?page=1&status=running",
    "pipeline.runs:project-two:running":
      "/api/pipeline-runs?page=1&projectId=project-two&status=running",
  };
  const { live, first } = await listening(f, ...Object.keys(lists));
  for (const [topic, path] of Object.entries(lists)) {
    assert.equal(first[topic].type, "snapshot", topic);
    assert.deepEqual(first[topic].data, await json(f, path), topic);
  }
  assert.equal(first["pipeline.runs:*:*"].data.total, 3);
  assert.equal(first["pipeline.runs:project-two:running"].data.total, 1);
  live.ws.close();
});

test("a run finishing changes the counts and page 1 within 1 s", async (t) => {
  const { f, store } = await seeded(t);
  const topics = [
    "pipeline.counts",
    "pipeline.counts:project-one",
    "pipeline.runs:*:*",
    "pipeline.runs:project-one:running",
  ];
  const { live } = await listening(f, ...topics);
  const started = Date.now();
  finish(store, "run-a");
  const frames = {};
  for (const topic of topics)
    frames[topic] = await live.next(
      (frame) => frame.topic === topic && frame.type === "state",
      1000,
    );
  assert.ok(Date.now() - started < 1000);
  assert.equal(frames["pipeline.counts"].data.counts.running, 1);
  assert.equal(frames["pipeline.counts"].data.counts.completed, 1);
  assert.equal(frames["pipeline.counts:project-one"].data.counts.completed, 1);
  assert.equal(
    frames["pipeline.runs:*:*"].data.runs.find((item) => item.id === "run-a").status,
    "completed",
  );
  assert.deepEqual(frames["pipeline.runs:project-one:running"].data, {
    runs: [],
    total: 0,
    page: 1,
    pageSize: 20,
  });
  assert.deepEqual(
    frames["pipeline.runs:*:*"].data,
    await json(f, "/api/pipeline-runs?page=1"),
  );
  live.ws.close();
});

test("a run of another project reads no list of this one", async (t) => {
  const { f, store } = await seeded(t);
  const reads = [];
  const list = f.application.pipelines.list.bind(f.application.pipelines);
  f.application.pipelines.list = (query) => {
    reads.push(query);
    return list(query);
  };
  const { live } = await listening(f, "pipeline.runs:project-one:*");
  reads.length = 0;
  finish(store, "run-c");
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.deepEqual(reads, []);
  finish(store, "run-b", "cancelled");
  const frame = await live.next(
    (item) => item.topic === "pipeline.runs:project-one:*" && item.type === "state",
    1000,
  );
  assert.equal(frame.data.runs.find((item) => item.id === "run-b").status, "cancelled");
  assert.equal(reads.length, 1);
  live.ws.close();
});

test("a filtered list subscriber gets one changed per run change of its project", async (t) => {
  const { f, store } = await seeded(t);
  const topics = ["pipeline.runs.changed:project-one", "pipeline.runs.changed"];
  const { live, first } = await listening(f, ...topics);
  for (const topic of topics) assert.equal(first[topic].type, "same", topic);
  finish(store, "run-c");
  const all = await live.next(
    (frame) => frame.topic === "pipeline.runs.changed" && frame.type === "changed",
    1000,
  );
  assert.equal(typeof all.revision, "number");
  finish(store, "run-a");
  await live.next((frame) => frame.topic === "pipeline.runs.changed:project-one", 1000);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const ofProject = live.frames.filter(
    (frame) => frame.topic === "pipeline.runs.changed:project-one",
  );
  // The `same` answer, then exactly one `changed` for project-one's run.
  assert.deepEqual(
    ofProject.map((frame) => frame.type),
    ["same", "changed"],
  );
  live.ws.close();
});

test("a deleted run leaves the counts and the lists", async (t) => {
  const { f } = await seeded(t);
  const { live } = await listening(
    f,
    "pipeline.counts:project-one",
    "pipeline.runs:project-one:failed",
    "pipeline.runs.changed:project-one",
  );
  const removed = await f.request("/api/pipeline-runs/run-b", { method: "DELETE" });
  assert.ok(removed.status < 300);
  const counts = await live.next(
    (frame) => frame.topic === "pipeline.counts:project-one" && frame.type === "state",
    1000,
  );
  assert.equal(counts.data.counts.failed, 0);
  const list = await live.next(
    (frame) =>
      frame.topic === "pipeline.runs:project-one:failed" && frame.type === "state",
    1000,
  );
  assert.equal(list.data.total, 0);
  await live.next(
    (frame) =>
      frame.topic === "pipeline.runs.changed:project-one" && frame.type === "changed",
    1000,
  );
  live.ws.close();
});

test("malformed list and count topics resolve like unknown ones", async (t) => {
  const { f } = await seeded(t);
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  for (const topic of [
    "pipeline.runs",
    "pipeline.runs:project-one",
    "pipeline.runs:project-one:paused",
    "pipeline.runs:*:*:*",
    "pipeline.runs:a/b:*",
    "pipeline.counts:",
    "pipeline.counts:*",
    "pipeline.runs.changed:*",
  ]) {
    live.send({ op: "sub", topic });
    assert.deepEqual(await live.next((frame) => frame.topic === topic), {
      type: "error",
      topic,
      code: "unknown-topic",
    });
  }
  live.ws.close();
});

test("the counts route refuses an invalid project filter", async (t) => {
  const { f } = await seeded(t);
  const response = await f.request(
    `/api/pipeline-run-counts?projectId=${"x".repeat(101)}`,
  );
  assert.equal(response.status, 400);
  const missing = await json(f, "/api/pipeline-run-counts?projectId=nothing-here");
  assert.equal(missing.counts.running, 0);
});
