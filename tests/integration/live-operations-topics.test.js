import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { openLive } from "../helpers/live-socket.js";
import { manualTimers } from "../helpers/manual-timers.js";
import { issue } from "../helpers/session-mcp.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { jobTopic } from "../../server/features/live/job-topics.js";
import {
  OPERATION_JOB_SAMPLE_MS,
  RELEASE_SESSIONS_SAMPLE_MS,
  operationJob,
  operationJobChanged,
  operationJobTopic,
  releaseSessionsTopic,
} from "../../server/features/operations/live-topics.js";
import {
  artifactsChangedTopic,
  artifactsUsageTopic,
} from "../../server/features/artifacts/live-topics.js";

// The operations job, release cleanup and artifact topics: each pushed value equals
// what its REST route answers.

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

const json = async (f, route) => (await f.request(route)).json();

function errorsOf(t) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => errors.push(args.join(" "));
  t.after(() => {
    console.error = original;
  });
  return errors;
}

test("a backup job's terminal status arrives as a frame equal to its route", async (t) => {
  const f = await applicationFixture(t);
  const started = await f.request("/api/operations/backups", {
    method: "POST",
    body: {},
  });
  assert.equal(started.status, 202);
  const { job } = await started.json();
  const topic = `job.operation:${job.id}`;
  const { live, first } = await listening(f, topic, "settings.summary");
  assert.equal(first[topic].type, "snapshot");
  const backupsBefore = first["settings.summary"].data.operations.backups;
  // Frames until the job ends; the running snapshot may already be its end.
  let frame = first[topic];
  while (frame.data.job.status === "running")
    frame = await live.next((next) => next.topic === topic, 30000);
  assert.equal(frame.data.job.status, "succeeded");
  assert.deepEqual(frame.data, await json(f, `/api/operations/jobs/${job.id}`));
  // The finished backup changes the settings summary, pushed without another write.
  const summaryRoute = await json(f, "/api/settings/summary");
  assert.notDeepEqual(summaryRoute.operations.backups, backupsBefore);
  let summary = first["settings.summary"];
  while (JSON.stringify(summary.data) !== JSON.stringify(summaryRoute))
    summary = await live.next((next) => next.topic === "settings.summary", 5000);
  assert.deepEqual(summary.data, summaryRoute);
  live.ws.close();
});

test("an unknown job answers one error and is not logged", async (t) => {
  const f = await applicationFixture(t);
  const errors = errorsOf(t);
  const id = randomUUID();
  assert.equal((await f.request(`/api/operations/jobs/${id}`)).status, 404);
  const { live, first } = await listening(f, `job.operation:${id}`);
  assert.deepEqual(first[`job.operation:${id}`], {
    type: "error",
    topic: `job.operation:${id}`,
  });
  assert.deepEqual(
    errors.filter((line) => line.includes("live topic")),
    [],
  );
  live.ws.close();
});

test("the release sessions snapshot equals its route", async (t) => {
  const f = await applicationFixture(t);
  const topic = "operations.release-sessions:1.0.0";
  const { live, first } = await listening(f, topic);
  assert.equal(first[topic].type, "snapshot");
  assert.deepEqual(
    first[topic].data,
    await json(f, "/api/operations/releases/cleanup/1.0.0/sessions"),
  );
  live.ws.close();
});

test("publishing an artifact pushes the usage and signals the lists", async (t) => {
  const f = await applicationFixture(t);
  const { live, first } = await listening(f, "artifacts.usage", "artifacts.changed");
  assert.equal(first["artifacts.usage"].type, "snapshot");
  assert.deepEqual(first["artifacts.usage"].data, await json(f, "/api/artifacts/usage"));
  assert.equal(first["artifacts.changed"].type, "same");
  const issued = await issue(f, { choices: true });
  const project = f.application.memory.projects().projects[0];
  await fs.writeFile(path.join(f.project, "report.html"), "<p>report</p>");
  const pushed = Promise.all([
    live.next((frame) => frame.topic === "artifacts.usage", 2000),
    live.next((frame) => frame.topic === "artifacts.changed", 2000),
  ]);
  const artifact = await f.application.artifacts.publish(
    { sessionId: issued.session.id, projectId: project.id, cwd: f.project },
    { requestId: randomUUID(), title: "Report", sourcePath: "report.html" },
    async () => {},
  );
  const [usage, changed] = await pushed;
  assert.equal(usage.type, "state");
  assert.deepEqual(usage.data, await json(f, "/api/artifacts/usage"));
  assert.ok(usage.data.usedBytes > first["artifacts.usage"].data.usedBytes);
  assert.equal(changed.type, "changed");
  // Pinning through the route signals the lists once more.
  const again = live.next((frame) => frame.topic === "artifacts.changed", 2000);
  const pinned = await f.request(`/api/artifacts/${artifact.id}`, {
    method: "PATCH",
    body: { pinned: true },
  });
  assert.equal(pinned.status, 200);
  assert.equal((await again).type, "changed");
  live.ws.close();
});

// The hub with manual timers, for the samplers and the job signals.
function hubOf(t) {
  const clock = manualTimers();
  const hub = new LiveHub({ timers: clock.timers });
  t.after(() => hub.close());
  return { clock, hub };
}

const owner = { role: "owner" };

function listen(hub, topic, principal = owner) {
  const frames = [];
  const stop = hub.subscribe(principal, topic, undefined, (frame) => frames.push(frame));
  return { frames, stop };
}

// Operations whose job files the test writes; `reads` counts get() calls.
function operationsOf(jobs) {
  const operations = {
    reads: 0,
    jobs: {
      get(id) {
        operations.reads += 1;
        if (!jobs[id]) throw Object.assign(new Error("gone"), { status: 404 });
        return structuredClone(jobs[id]);
      },
    },
  };
  return operations;
}

const ID = "0000aaaa-0000-4000-8000-000000000000";

test("a running job is sampled (another process may write it); an ended one is not", async (t) => {
  assert.equal(OPERATION_JOB_SAMPLE_MS, 1500);
  const { clock, hub } = hubOf(t);
  const jobs = { [ID]: { id: ID, kind: "release-activate", status: "running" } };
  const operations = operationsOf(jobs);
  hub.define(operationJobTopic({ operations }));
  const { frames, stop } = listen(hub, `job.operation:${ID}`);
  await clock.advance(0);
  assert.deepEqual(frames[0].data, { job: jobs[ID] });
  jobs[ID] = { ...jobs[ID], status: "succeeded" };
  await clock.advance(OPERATION_JOB_SAMPLE_MS);
  assert.equal(frames.at(-1).type, "state");
  assert.equal(frames.at(-1).data.job.status, "succeeded");
  const reads = operations.reads;
  await clock.advance(OPERATION_JOB_SAMPLE_MS * 10);
  // An ended job is not read again.
  assert.equal(operations.reads, reads);
  assert.equal(frames.length, 2);
  stop();
  const after = operations.reads;
  await clock.advance(60000);
  assert.equal(operations.reads, after);
});

test("a helper's write to a watched job file is read before the next sample", async (t) => {
  const { clock, hub } = hubOf(t);
  const jobs = { [ID]: { id: ID, kind: "release-activate", status: "running" } };
  const operations = operationsOf(jobs);
  operations.jobs.directory = "/jobs";
  const followed = [];
  const watchers = {
    add(directory, name, listener) {
      const entry = { directory, name, listener, released: false };
      followed.push(entry);
      return () => (entry.released = true);
    },
  };
  hub.define(jobTopic(operationJob({ operations }, { watchers })));
  const { frames, stop } = listen(hub, `job.operation:${ID}`);
  await clock.advance(0);
  assert.deepEqual(
    followed.map(({ directory, name }) => [directory, name]),
    [["/jobs", `${ID}.json`]],
  );
  jobs[ID] = { ...jobs[ID], status: "succeeded" };
  followed[0].listener("rename", `${ID}.json`);
  await clock.advance(200);
  assert.equal(frames.at(-1).data.job.status, "succeeded");
  stop();
  assert.equal(followed[0].released, true);
});

test("a job read that ends after the last unsubscribe leaves no sampled status", async () => {
  const topic = jobTopic({
    kind: "demo",
    param: /[a-z]+/,
    sampleMs: 1000,
    status: (value) => value.status,
    read: async () => ({ status: "running" }),
  });
  const stop = topic.watch({ param: "a", invalidate() {}, nudge() {} });
  const reading = topic.read(owner, "a");
  stop();
  await reading;
  assert.equal(topic.sampling("a"), false);
  // While watched, a running job is sampled.
  topic.watch({ param: "a", invalidate() {}, nudge() {} });
  await topic.read(owner, "a");
  assert.equal(topic.sampling("a"), true);
});

test("a job change signals its topic, the summary at its end and release sessions", () => {
  const signaled = [];
  const spy = {
    invalidate: (name, param) => signaled.push([name, param]),
    invalidateWhere: (name, predicate) => signaled.push([name, predicate("9.9.9")]),
  };
  operationJobChanged(spy, { id: "a", kind: "backup", status: "running" });
  assert.deepEqual(signaled, [["job.operation", "a"]]);
  signaled.length = 0;
  operationJobChanged(spy, { id: "a", kind: "backup", status: "succeeded" });
  assert.deepEqual(signaled, [
    ["job.operation", "a"],
    ["settings.summary", undefined],
  ]);
  signaled.length = 0;
  operationJobChanged(spy, { id: "b", kind: "release-migrate", status: "failed" });
  assert.deepEqual(signaled, [
    ["job.operation", "b"],
    ["settings.summary", undefined],
    ["operations.release-sessions", true],
  ]);
  // Without a hub (before the server listens) nothing happens.
  signaled.length = 0;
  operationJobChanged(undefined, { id: "a", status: "failed" });
  assert.deepEqual(signaled, []);
});

test("release sessions are sampled every 3 s, only while someone subscribes", async (t) => {
  assert.equal(RELEASE_SESSIONS_SAMPLE_MS, 3000);
  const { clock, hub } = hubOf(t);
  let reads = 0;
  const releaseMigration = {
    plan: async (version) => {
      reads += 1;
      return { version, sessions: [], reads };
    },
  };
  hub.define(releaseSessionsTopic({ releaseMigration }));
  assert.equal(
    listen(hub, "operations.release-sessions:x")?.frames[0]?.code,
    "unknown-topic",
  );
  const { frames, stop } = listen(hub, "operations.release-sessions:2.1.0");
  await clock.advance(0);
  assert.equal(reads, 1);
  assert.equal(frames[0].data.version, "2.1.0");
  await clock.advance(3000);
  assert.equal(reads, 2);
  hub.invalidate("operations.release-sessions", "2.1.0");
  await clock.advance(1000);
  assert.equal(reads, 3);
  stop();
  await clock.advance(60000);
  assert.equal(reads, 3);
});

test("every operations and artifact topic is the owner's alone", () => {
  for (const topic of [
    operationJobTopic({}),
    releaseSessionsTopic({}),
    artifactsUsageTopic({}),
    artifactsChangedTopic(),
  ]) {
    assert.equal(topic.authorize(owner), true, topic.name);
    assert.equal(topic.authorize({ role: "user", userId: "u1" }), false, topic.name);
    assert.equal(topic.authorize(null), false, topic.name);
  }
  assert.equal(artifactsChangedTopic().mode, "signal");
  assert.equal(artifactsUsageTopic({}).sampleMs, undefined);
});
