import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { subscribe, until } from "../helpers/live-hub-subscriber.js";
import { openLive } from "../helpers/live-socket.js";
import { applicationFixture } from "../helpers/application.js";
import { fileFixture, waitForFileJob } from "../helpers/file-explorer.js";
import { submitCopy } from "../helpers/file-copy.js";
import { LiveHub } from "../../server/features/live/live-hub.js";
import { reportLiveError } from "../../server/application/live-wiring.js";
import { FileStore } from "../../server/features/files/file-store.js";
import { FileJobs } from "../../server/features/files/file-jobs.js";
import {
  fileJobsChanged,
  filesJobsTopic,
} from "../../server/features/files/live-topics.js";
import { ChatDelivery } from "../../server/features/chat/chat-delivery.js";
import {
  deliveriesChanged,
  sessionDeliveriesTopic,
} from "../../server/features/chat/live-delivery-topics.js";

// Task 3.3: the job envelopes of a file scope (`files.jobs:<global|session:id>`) and
// the chat delivery signal (`session.deliveries:<id>`). Every job write signals, an
// envelope's `updatedAt` rises with each write (also its entries), and hook failures
// are logged, never thrown.

const user = { role: "user", userId: "u1" };

function errorsOf(t) {
  const errors = [];
  const original = console.error;
  console.error = (...args) => {
    const text = args.join(" ");
    // Node's own warning when SQLite first opens is not an application log.
    if (!text.includes("ExperimentalWarning")) errors.push(text);
  };
  t.after(() => {
    console.error = original;
  });
  return errors;
}

const fastHub = (t, options = {}) => {
  const hub = new LiveHub({ debounceMs: 5, maxWaitMs: 20, ...options });
  t.after(() => hub.close());
  return hub;
};

const temporary = (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-live-files-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

const copyOperation = (now) => ({
  requestId: `${now}:${randomUUID()}`,
  kind: "copy",
  sources: ["/source/a"],
  target: "/target",
  name: null,
  options: {},
});

test("every job write signals its scope and raises the envelope's updatedAt", (t) => {
  const now = 1_800_000_000_000;
  const store = new FileStore({ dataDir: temporary(t), now: () => now });
  const signals = [];
  const jobs = new FileJobs({
    store,
    locks: {},
    barrier: { run: (fn) => fn() },
    limits: {},
    handlers: new Map(),
    onChange: (scopeId) => signals.push(scopeId),
  });
  t.after(() => {
    clearInterval(jobs.pruneTimer);
    store.close();
  });
  const scope = { id: "f1:scope" };
  const { job } = store.request(scope, copyOperation(now));
  assert.equal(job.updatedAt, now);
  assert.deepEqual(signals, ["f1:scope"]);
  // The clock stands still, yet each write reads differently.
  const running = store.transition(job.id, "queued", "running");
  assert.equal(running.updatedAt, now + 1);
  store.transition(job.id, "running", "running", { completedEntries: 1 });
  assert.equal(store.getJob(scope, job.id).updatedAt, now + 2);
  // A result row changes no envelope field, but the version its pages are read by.
  store.putEntry(job.id, { id: "row", status: "completed" });
  assert.equal(store.getJob(scope, job.id).updatedAt, now + 3);
  assert.equal(store.listJobs(scope).jobs[0].updatedAt, now + 3);
  assert.deepEqual(signals, Array(4).fill("f1:scope"));
  // A transition that finds another state writes nothing and signals nothing.
  assert.equal(store.transition(job.id, "queued", "running"), null);
  assert.equal(signals.length, 4);
  // Pruning removes ended envelopes of any scope: it signals without one.
  store.transition(job.id, "running", "completed");
  assert.equal(signals.length, 5);
  store.prune(now + 8 * 86400000);
  assert.deepEqual(store.listJobs(scope).jobs, []);
  assert.deepEqual(signals.slice(5), [null]);
  // A prune that removes nothing signals nothing.
  store.prune(now + 8 * 86400000);
  assert.equal(signals.length, 6);
});

test("a first page that more jobs follow carries the running ones beyond it", (t) => {
  const now = 1_800_000_000_000;
  const store = new FileStore({ dataDir: temporary(t), now: () => now });
  t.after(() => store.close());
  const scope = { id: "f1:scope" };
  const ids = [];
  for (let i = 0; i < 201; i++) ids.push(store.request(scope, copyOperation(now)).job.id);
  // A page that holds every job needs none.
  assert.equal(store.listJobs({ id: "f1:other" }).active, undefined);
  for (const id of ids.slice(0, 200)) store.transition(id, "queued", "completed");
  // Beyond the page: an upload group, its running child and an ended job.
  const insert = store.db.prepare(
    "INSERT INTO jobs(id,scope_id,kind,status,operation,document,parent_job_id,created_at,updated_at) VALUES(?,?,?,?,'{}',?,?,?,?)",
  );
  const doc = JSON.stringify({ completedEntries: 0, conflict: null, issue: null });
  insert.run("group", scope.id, "upload_group", "running", doc, null, now, now);
  insert.run("child", scope.id, "upload", "running", doc, "group", now, now);
  insert.run("ended", scope.id, "copy", "completed", doc, null, now, now);
  const first = store.listJobs(scope);
  assert.equal(first.jobs.length, 200);
  assert.ok(first.nextCursor);
  assert.deepEqual(
    first.active.map((job) => [job.id, job.status]),
    [
      [ids[200], "queued"],
      ["group", "running"],
    ],
  );
  assert.deepEqual(first.active[0], store.getJob(scope, ids[200]));
  // Later pages list everything themselves.
  assert.equal(store.listJobs(scope, first.nextCursor).active, undefined);
  // At most 50.
  for (let i = 0; i < 60; i++) store.request(scope, copyOperation(now));
  assert.equal(store.listJobs(scope).active.length, 50);
});

test("a failing file-job listener is logged and the write still succeeds", (t) => {
  const errors = errorsOf(t);
  const now = 1_800_000_000_000;
  const store = new FileStore({ dataDir: temporary(t), now: () => now });
  const jobs = new FileJobs({
    store,
    locks: {},
    barrier: { run: (fn) => fn() },
    limits: {},
    handlers: new Map(),
    onChange: () => {
      throw new Error("listener broke");
    },
  });
  t.after(() => {
    clearInterval(jobs.pruneTimer);
    store.close();
  });
  const { job } = store.request({ id: "f1:scope" }, copyOperation(now));
  assert.equal(store.transition(job.id, "queued", "running").status, "running");
  assert.equal(errors.length, 2);
  assert.match(errors[0], /file job/i);
});

test("files.jobs is the scope's first jobs page, owner only, refusals unlogged", async (t) => {
  const errors = errorsOf(t);
  const now = Date.now();
  const store = new FileStore({ dataDir: temporary(t) });
  t.after(() => store.close());
  const global = { id: "f1:global" },
    project = { id: "f1:project" };
  const contexts = [];
  const files = {
    async context(sessionId) {
      contexts.push(sessionId);
      if (sessionId === null) return global;
      if (sessionId === "s1") return project;
      throw Object.assign(new Error("gone"), { code: "FILE_INVALID_SCOPE", status: 404 });
    },
    jobs: { list: (scope, cursor) => store.listJobs(scope, cursor) },
  };
  const hub = fastHub(t, { onError: reportLiveError });
  hub.define(filesJobsTopic({ files }));
  store.request(global, copyOperation(now));
  const globalLive = subscribe(hub, "files.jobs:global");
  const projectLive = subscribe(hub, "files.jobs:session:s1");
  const first = await globalLive.next();
  assert.equal(first.type, "snapshot");
  assert.deepEqual(first.data, store.listJobs(global));
  assert.deepEqual((await projectLive.next()).data, { jobs: [], nextCursor: null });
  assert.deepEqual(contexts.sort(), [null, "s1"].sort());
  // A job in the project scope: its topic pushes, the global page is unchanged.
  store.request(project, copyOperation(now));
  fileJobsChanged(hub, project.id);
  const pushed = await projectLive.next((frame) => frame.type === "state");
  assert.deepEqual(pushed.data, store.listJobs(project));
  // Only the written scope's instance reads again.
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(contexts.sort(), [null, "s1", "s1"].sort());
  assert.equal(globalLive.frames.length, 1);
  // A write of any scope (pruning) reads every instance.
  fileJobsChanged(hub, null);
  await until(() => contexts.length >= 5);
  // A session that is gone is the route's 404; it is not logged.
  assert.equal((await subscribe(hub, "files.jobs:session:gone").next()).type, "error");
  assert.deepEqual(errors, []);
  // Only the owner, and only the two parameter forms.
  assert.equal(subscribe(hub, "files.jobs:global", user).frames[0].code, "unknown-topic");
  for (const topic of ["files.jobs", "files.jobs:other", "files.jobs:session:"])
    assert.equal(subscribe(hub, topic).frames[0].code, "unknown-topic", topic);
});

test("every receipt write and a session's discard signal its deliveries", async (t) => {
  const errors = errorsOf(t);
  const dataDir = temporary(t);
  const signals = [];
  const delivery = new ChatDelivery({
    dataDir,
    sessions: {},
    requests: {},
    models: {},
    onChange: (sessionId) => signals.push(sessionId),
  });
  const deliveryId = randomUUID();
  const file = delivery.file("s1", deliveryId);
  delivery.write(file, { version: 1, deliveryId, status: "pending" });
  assert.deepEqual(signals, ["s1"]);
  // A held message leaving the queue changes what its status answers (pending).
  delivery.active.add(file);
  delivery.held.finish({ id: "s1", file });
  assert.deepEqual(signals, ["s1", "s1"]);
  await delivery.discard("s1");
  assert.deepEqual(signals, ["s1", "s1", "s1"]);
  assert.deepEqual(errors, []);
  // A failing listener is logged; the write stands.
  const broken = new ChatDelivery({
    dataDir,
    sessions: {},
    requests: {},
    models: {},
    onChange: () => {
      throw new Error("listener broke");
    },
  });
  const other = broken.file("s2", randomUUID());
  broken.write(other, { version: 1, status: "pending" });
  assert.ok(fs.existsSync(other));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /deliver/i);
});

test("session.deliveries signals one session's changes, owner only", async (t) => {
  const hub = fastHub(t);
  hub.define(sessionDeliveriesTopic());
  const one = subscribe(hub, "session.deliveries:s1");
  const two = subscribe(hub, "session.deliveries:s2");
  assert.equal((await one.next()).type, "same");
  await two.next();
  deliveriesChanged(hub, "s1");
  assert.equal((await one.next()).type, "changed");
  await assert.rejects(two.next(() => true, 100));
  assert.equal(
    subscribe(hub, "session.deliveries:s1", user).frames[0].code,
    "unknown-topic",
  );
  for (const topic of ["session.deliveries", "session.deliveries:a b"])
    assert.equal(subscribe(hub, topic).frames[0].code, "unknown-topic", topic);
  deliveriesChanged(null, "s1");
});

const json = async (f, route) => (await f.request(route)).json();

test("a copy job's envelopes arrive as frames equal to GET /api/files/jobs", async (t) => {
  const f = await applicationFixture(t);
  const topic = "files.jobs:global";
  const live = openLive(f);
  await live.next((frame) => frame.type === "hello");
  live.send({ op: "sub", topic });
  const first = await live.next((frame) => frame.topic === topic, 5000);
  assert.equal(first.type, "snapshot");
  assert.deepEqual(first.data, await json(f, "/api/files/jobs"));
  // A copy that meets an existing file waits for a decision: that state is pushed.
  const source = path.join(f.home, "source"),
    target = path.join(f.home, "target");
  fs.mkdirSync(source);
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(source, "same.txt"), "source data");
  fs.writeFileSync(path.join(target, "same.txt"), "old target");
  const started = await submitCopy(f, [path.join(source, "same.txt")], target);
  const waiting = await live.next(
    (frame) =>
      frame.topic === topic &&
      frame.data?.jobs?.some(
        (job) => job.id === started.id && job.status === "waiting_for_conflict",
      ),
    5000,
  );
  const job = await waitForFileJob(f, started.id, { states: ["waiting_for_conflict"] });
  assert.deepEqual(waiting.data, await json(f, "/api/files/jobs"));
  const context = await json(f, "/api/files/context");
  const resolved = await f.request(`/api/files/jobs/${job.id}/resolve`, {
    method: "POST",
    headers: { "x-file-scope": context.scopeId },
    body: { conflictId: job.conflict.id, decision: "skip", applyToRemaining: false },
  });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  const ended = await live.next(
    (frame) =>
      frame.topic === topic &&
      frame.data?.jobs?.some(
        (item) =>
          item.id === started.id &&
          !["running", "waiting_for_conflict"].includes(item.status),
      ),
    5000,
  );
  await waitForFileJob(f, started.id);
  assert.deepEqual(ended.data, await json(f, "/api/files/jobs"));
  assert.ok(ended.data.jobs[0].updatedAt > waiting.data.jobs[0].updatedAt);
  // No result rows travel with the envelopes.
  assert.equal(JSON.stringify(ended.data).includes("same.txt"), false);
  live.ws.close();
});

test("the chat delivery hook is wired to the hub", async (t) => {
  const f = await applicationFixture(t);
  const app = f.application;
  const signals = [];
  const invalidate = app.live.invalidate.bind(app.live);
  app.live.invalidate = (name, param) => {
    signals.push([name, param]);
    return invalidate(name, param);
  };
  app.live.invalidateWhere = (name) => signals.push([name, "scoped"]);
  app.chatDelivery.changed("session-one");
  app.files.store.onJobChange("f1:any");
  assert.deepEqual(signals, [
    ["session.deliveries", "session-one"],
    ["files.jobs", "scoped"],
  ]);
});

test("unchanged rewrites of a finished job keep its version and prune clock", async (t) => {
  const f = await fileFixture(t);
  let now = Date.now();
  const store = new FileStore({ dataDir: f.dataDir, now: () => now });
  t.after(() => store.close());
  const { job } = store.request(f.globalScope, {
    requestId: `${now}:${randomUUID()}`,
    kind: "size",
    sources: [],
    target: null,
    name: null,
    options: {},
  });
  store.putEntry(job.id, { id: "row", status: "completed" });
  store.transition(job.id, "queued", "completed", {});
  const version = store.getJob(f.globalScope, job.id).updatedAt;
  // Recovery on a later start writes the same rows and status again.
  now += 6 * 86400000;
  store.putEntry(job.id, { id: "row", status: "completed" });
  assert.ok(store.transition(job.id, "completed", "completed", {}));
  assert.equal(store.getJob(f.globalScope, job.id).updatedAt, version);
  // A real change is a new version.
  store.putEntry(job.id, { id: "row", status: "skipped" });
  assert.ok(store.getJob(f.globalScope, job.id).updatedAt > version);
  // Seven days after its last real change the job is pruned.
  now += 2 * 86400000;
  store.prune(now);
  assert.ok(store.getJob(f.globalScope, job.id));
  now += 6 * 86400000;
  store.prune(now);
  assert.throws(() => store.getJob(f.globalScope, job.id), { code: "FILE_NOT_FOUND" });
});
