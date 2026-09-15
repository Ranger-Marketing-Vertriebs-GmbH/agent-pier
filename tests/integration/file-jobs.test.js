import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate as tick } from "node:timers/promises";
import { FileStore } from "../../server/features/files/file-store.js";
import { FileJobs } from "../../server/features/files/file-jobs.js";
import { PathLocks } from "../../server/features/files/file-locks.js";
import { registerFileJobHandler } from "../../server/features/files/file-job-handlers.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";
import { readFileLimits } from "../../server/features/files/file-limits.js";
import { createFileServices } from "../../server/application/files.js";
import { fileFixture } from "../helpers/file-explorer.js";

const deferred = () => Promise.withResolvers();
const operation = (patch = {}) => ({
  requestId: `${Date.now()}:${randomUUID()}`,
  kind: "size",
  sources: [],
  target: null,
  name: null,
  options: {},
  ...patch,
});
async function fixture(t, handler = async () => {}, extra = {}) {
  const f = await fileFixture(t);
  const store = new FileStore({ dataDir: f.dataDir });
  const barrier = new MutationBarrier(),
    locks = new PathLocks();
  const handlers = new Map([["size", handler]]);
  const jobs = new FileJobs({
    store,
    locks,
    barrier,
    limits: readFileLimits(),
    handlers,
    ...extra,
  });
  t.after(() => jobs.close());
  return { ...f, store, jobs, barrier, locks, handlers };
}
async function settled(jobs, scope, id, status = "completed") {
  for (let i = 0; i < 200; i++) {
    const job = jobs.get(scope, id);
    if (job.status === status) return job;
    await tick();
  }
  assert.equal(jobs.get(scope, id).status, status);
}

test("durable idempotency reuses one handler and rejects changed canonical bodies", async (t) => {
  let calls = 0;
  const f = await fixture(t, async () => {
    calls++;
  });
  const op = operation({ options: { a: 1, b: 2 } });
  const [a, b] = await Promise.all([
    f.jobs.start(f.globalScope, op),
    f.jobs.start(f.globalScope, { ...op, options: { b: 2, a: 1 } }),
  ]);
  assert.equal(a.id, b.id);
  await settled(f.jobs, f.globalScope, a.id);
  assert.equal(calls, 1);
  await assert.rejects(f.jobs.start(f.globalScope, { ...op, name: "different" }), {
    code: "FILE_REQUEST_CONFLICT",
  });
  assert.throws(() => f.jobs.get(f.projectScope, a.id), { code: "FILE_NOT_FOUND" });
  assert.deepEqual(f.jobs.list(f.projectScope), { jobs: [], nextCursor: null });
  await f.jobs.close();
  const store = new FileStore({ dataDir: f.dataDir });
  t.after(() => store.close());
  assert.equal(store.request(f.globalScope, op).created, false);
  assert.equal(store.getJob(f.globalScope, a.id).status, "completed");
});

test("startup interrupts unfinished jobs and pruning preserves recovery references", async (t) => {
  const f = await fileFixture(t);
  let now = Date.now();
  let store = new FileStore({ dataDir: f.dataDir, now: () => now });
  const old = store.request(f.globalScope, operation()).job;
  const journal = store.request(f.globalScope, operation()).job;
  const parent = store.request(f.globalScope, operation()).job;
  const child = store.request(f.globalScope, operation({ parentJobId: parent.id })).job;
  const trashed = store.request(f.globalScope, operation()).job;
  store.putPublication({
    id: "publication",
    jobId: journal.id,
    phase: "prepared",
    document: { privatePath: "private" },
  });
  store.putTrash({
    id: "trash",
    jobId: trashed.id,
    scopeId: f.globalScope.id,
    originalPath: "visible",
    deletedAt: now,
    type: "file",
    size: 1,
    reason: null,
    privatePath: "secret",
  });
  store.transition(parent.id, "queued", "completed", {});
  store.close();
  store = new FileStore({ dataDir: f.dataDir, now: () => now });
  t.after(() => store.close());
  assert.equal(store.getJob(f.globalScope, old.id).status, "interrupted");
  assert.equal(store.getJob(f.globalScope, journal.id).status, "interrupted");
  store.transition(child.id, "interrupted", "queued", {});
  now += 8 * 86400000;
  store.prune(now);
  assert.throws(() => store.getJob(f.globalScope, old.id), { code: "FILE_NOT_FOUND" });
  for (const id of [journal.id, parent.id, child.id, trashed.id])
    assert.ok(store.getJob(f.globalScope, id));
  assert.equal(store.listPublications()[0].document.privatePath, "private");
  assert.equal(JSON.stringify(store.listTrash(f.globalScope)).includes("secret"), false);
  assert.throws(
    () =>
      store.request(
        f.globalScope,
        operation({ requestId: `${now - 8 * 86400000}:${randomUUID()}` }),
      ),
    { code: "FILE_REQUEST_EXPIRED", status: 410 },
  );
  assert.throws(
    () =>
      store.request(
        f.globalScope,
        operation({ requestId: `${now + 300001}:${randomUUID()}` }),
      ),
    { code: "FILE_INVALID_REQUEST", status: 400 },
  );
});

test("registration waits for snapshots and handlers never inherit the HTTP lease", async (t) => {
  const entered = deferred(),
    release = deferred();
  const f = await fixture(t, async () => {
    assert.equal(f.barrier.hasLease(), false);
    entered.resolve();
    await release.promise;
  });
  const snapshotEntered = deferred(),
    snapshotRelease = deferred();
  const snapshot = f.barrier.snapshot(async () => {
    snapshotEntered.resolve();
    await snapshotRelease.promise;
  });
  await snapshotEntered.promise;
  let registered = false;
  const started = f.barrier.run(async () => {
    const job = await f.jobs.start(f.globalScope, operation());
    registered = true;
    await entered.promise;
    return job;
  });
  await tick();
  assert.equal(registered, false);
  snapshotRelease.resolve();
  await snapshot;
  const job = await started;
  await f.barrier.snapshot(() => {});
  release.resolve();
  await settled(f.jobs, f.globalScope, job.id);
});

test("transfers have three slots, reservations use none, metadata and cancellation stay live", async (t) => {
  const gates = [deferred(), deferred(), deferred()],
    entered = [deferred(), deferred(), deferred()];
  const f = await fixture(t);
  let calls = 0;
  registerFileJobHandler(
    f.handlers,
    "copy",
    async ({ signal }) => {
      const i = calls++;
      entered[i]?.resolve();
      await Promise.race([
        gates[i]?.promise,
        new Promise((r) => signal.addEventListener("abort", r, { once: true })),
      ]);
    },
    { transfer: true },
  );
  const reserved = await f.jobs.reserve(f.globalScope, operation({ kind: "upload" }));
  const transfers = await Promise.all(
    Array.from({ length: 4 }, () =>
      f.jobs.start(f.globalScope, operation({ kind: "copy" })),
    ),
  );
  await Promise.all(entered.map((x) => x.promise));
  assert.equal(calls, 3);
  assert.equal(f.jobs.get(f.globalScope, transfers[3].id).status, "queued");
  const meta = await f.jobs.start(f.globalScope, operation());
  await settled(f.jobs, f.globalScope, meta.id);
  await f.jobs.cancel(f.globalScope, transfers[3].id);
  assert.equal(f.jobs.get(f.globalScope, transfers[3].id).status, "cancelled");
  assert.equal(f.jobs.get(f.globalScope, reserved.id).status, "queued");
  await f.jobs.close();
  assert.equal(calls, 3);
  await assert.rejects(f.jobs.start(f.globalScope, operation()), {
    code: "FILE_JOBS_CLOSED",
  });
});

test("fresh queued project admission rejects changed session state", async (t) => {
  const f = await fileFixture(t);
  let session = { id: "fixture", cwd: f.project };
  const services = createFileServices({
    config: { home: f.home, dataDir: f.dataDir, files: { limits: { transfers: 1 } } },
    sessions: { get: async () => session },
    mutationBarrier: new MutationBarrier(),
  });
  t.after(() => services.close());
  const entered = deferred(),
    release = deferred();
  let calls = 0;
  registerFileJobHandler(
    services.handlers,
    "copy",
    async () => {
      calls++;
      entered.resolve();
      await release.promise;
    },
    { transfer: true },
  );
  const scope = await services.context("fixture");
  await services.jobs.start(scope, operation({ kind: "copy" }));
  await entered.promise;
  const queued = await services.jobs.start(scope, operation({ kind: "copy" }));
  session = { ...session, cwd: f.home };
  release.resolve();
  const failed = await settled(services.jobs, scope, queued.id, "failed");
  assert.equal(failed.issue.code, "FILE_INVALID_SCOPE");
  assert.equal(calls, 1);
});

test("conflict identity is durable, stale resolution fails and cancellation aborts entered work", async (t) => {
  const entered = deferred(),
    after = deferred();
  const f = await fixture(t, async ({ conflict, signal }) => {
    entered.resolve();
    const decision = await conflict({
      type: "exists",
      path: "visible",
      choices: ["skip", "cancel"],
      privatePath: "secret",
    });
    assert.equal(decision.decision, "skip");
    after.resolve();
    await new Promise((r) => signal.addEventListener("abort", r, { once: true }));
  });
  const job = await f.jobs.start(f.globalScope, operation());
  await entered.promise;
  const waiting = await settled(f.jobs, f.globalScope, job.id, "waiting_for_conflict");
  assert.equal(JSON.stringify(waiting).includes("secret"), false);
  await f.barrier.snapshot(() => {});
  await assert.rejects(
    f.jobs.resolve(f.globalScope, job.id, {
      conflictId: "stale",
      decision: "skip",
      applyToRemaining: false,
    }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  await f.jobs.resolve(f.globalScope, job.id, {
    conflictId: waiting.conflict.id,
    decision: "skip",
    applyToRemaining: false,
  });
  await after.promise;
  await f.jobs.cancel(f.globalScope, job.id);
  await settled(f.jobs, f.globalScope, job.id, "cancelled");
});

test("entry pages and progress are bounded projections, terminal transitions are conditional", async (t) => {
  const f = await fixture(t);
  const job = await f.jobs.reserve(f.globalScope, operation({ kind: "upload" }));
  for (let i = 0; i < 205; i++)
    f.store.putEntry(job.id, {
      id: String(i),
      path: `file-${i}`,
      status: "queued",
      privatePath: "secret",
      text: "private contents",
    });
  const first = f.jobs.entries(f.globalScope, job.id);
  assert.equal(first.entries.length, 200);
  assert.equal(JSON.stringify(first).includes("secret"), false);
  assert.equal(JSON.stringify(first).includes("private contents"), false);
  assert.equal(f.jobs.entries(f.globalScope, job.id, first.nextCursor).entries.length, 5);
  assert.throws(() => f.jobs.entries(f.projectScope, job.id), { code: "FILE_NOT_FOUND" });
  assert.throws(() => f.jobs.entries(f.globalScope, job.id, "garbage"), {
    code: "FILE_INVALID_CURSOR",
  });
  assert.ok(
    f.store.transition(job.id, "queued", "running", {
      completedEntries: 2,
      text: "secret",
    }),
  );
  assert.equal(f.store.transition(job.id, "queued", "failed", {}), null);
  assert.equal(f.jobs.get(f.globalScope, job.id).completedEntries, 2);
  assert.equal(
    JSON.stringify(f.jobs.get(f.globalScope, job.id)).includes("secret"),
    false,
  );
});

test("reserved transfers run once on byte arrival and close waits for owned cleanup", async (t) => {
  const f = await fixture(t);
  const reserved = await f.jobs.reserve(f.globalScope, operation({ kind: "upload" }));
  const entered = deferred(),
    aborted = deferred(),
    cleanup = deferred();
  let calls = 0;
  const handler = async ({ signal, report }) => {
    calls++;
    await report({ completedBytes: 7 });
    entered.resolve();
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    aborted.resolve();
    await cleanup.promise;
  };
  const first = f.jobs.runReserved(f.globalScope, reserved.id, handler);
  await entered.promise;
  const duplicate = f.jobs.runReserved(f.globalScope, reserved.id, handler);
  let closed = false;
  const closing = f.jobs.close().then(() => {
    closed = true;
  });
  await aborted.promise;
  await tick();
  assert.equal(closed, false);
  assert.equal(f.store.getJob(f.globalScope, reserved.id).completedBytes, 7);
  cleanup.resolve();
  const [a, b] = await Promise.all([first, duplicate]);
  assert.equal(a.id, b.id);
  assert.equal(a.status, "cancelled");
  assert.equal(calls, 1);
  await closing;
});

test("shutdown aborts a published conflict and never waits for user input", async (t) => {
  const f = await fixture(t, async ({ conflict }) =>
    conflict({ type: "exists", choices: ["skip", "cancel"] }),
  );
  const job = await f.jobs.start(f.globalScope, operation());
  const waiting = await settled(f.jobs, f.globalScope, job.id, "waiting_for_conflict");
  await f.jobs.close();
  const store = new FileStore({ dataDir: f.dataDir });
  t.after(() => store.close());
  assert.equal(store.getJob(f.globalScope, job.id).status, "cancelled");
  assert.deepEqual(store.getDecision(job.id), {
    conflictId: waiting.conflict.id,
    decision: "cancel",
    applyToRemaining: false,
  });
});

for (const type of ["path", "barrier"])
  test(`conflict waits reject a held ${type} lease`, async (t) => {
    let f;
    f = await fixture(t, async ({ conflict }) => {
      const act = () => conflict({ type: "exists", choices: ["skip"] });
      if (type === "path") await f.locks.withPaths([f.home], act);
      else await f.barrier.run(act);
    });
    const job = await f.jobs.start(f.globalScope, operation());
    const failed = await settled(f.jobs, f.globalScope, job.id, "failed");
    assert.deepEqual(failed.issue, { code: "FILE_IO_ERROR", args: {} });
    await f.barrier.snapshot(() => f.locks.withPaths([f.home], () => {}));
  });

test("progress and manifest limits fail safely without persisting content", async (t) => {
  const f = await fixture(t, async ({ report }) =>
    report({ completedBytes: 51 * 1024 ** 3, secret: "hidden" }),
  );
  registerFileJobHandler(f.handlers, "copy", f.handlers.get("size"), { transfer: true });
  const job = await f.jobs.start(f.globalScope, operation({ kind: "copy" }));
  const failed = await settled(f.jobs, f.globalScope, job.id, "failed");
  assert.equal(failed.issue.code, "FILE_LIMIT_EXCEEDED");
  assert.equal(failed.completedBytes, 0);
  assert.throws(
    () => f.store.putEntry(job.id, { id: "oversized", privatePath: "x".repeat(65536) }),
    { code: "FILE_LIMIT_EXCEEDED" },
  );
});

test("forward job cursors remain valid after pruning the previous page", async (t) => {
  const f = await fileFixture(t);
  let now = Date.now();
  const store = new FileStore({ dataDir: f.dataDir, now: () => now });
  t.after(() => store.close());
  const op = operation();
  for (let i = 0; i < 201; i++) {
    const job = store.request(f.globalScope, i === 0 ? op : operation()).job;
    store.transition(job.id, "queued", "completed", {});
  }
  const page = store.listJobs(f.globalScope);
  assert.equal(page.jobs.length, 200);
  assert.ok(page.nextCursor);
  assert.throws(() => store.listJobs(f.projectScope, page.nextCursor), {
    code: "FILE_INVALID_CURSOR",
  });
  now += 8 * 86400000;
  store.prune(now);
  assert.deepEqual(store.listJobs(f.globalScope), { jobs: [], nextCursor: null });
  assert.throws(() => store.request(f.globalScope, op), {
    code: "FILE_REQUEST_EXPIRED",
    status: 410,
  });
  const fresh = store.request(
    f.globalScope,
    operation({ requestId: `${now}:${randomUUID()}` }),
  ).job;
  assert.equal(store.listJobs(f.globalScope, page.nextCursor).jobs[0]?.id, fresh.id);
});

test("public registration keeps search read-only and rejects options outside its validator", async (t) => {
  const f = await fixture(t);
  registerFileJobHandler(f.handlers, "size", async () => {}, {
    public: true,
    validate: (op) => Object.keys(op.options).length === 0,
  });
  const scope = { ...f.globalScope, readOnly: true };
  const job = await f.jobs.start(scope, operation(), { publicOnly: true });
  await settled(f.jobs, scope, job.id);
  await assert.rejects(
    f.jobs.start(scope, operation({ options: { unexpected: true } }), {
      publicOnly: true,
    }),
    { code: "FILE_INVALID_OPERATION" },
  );
});

test("public handler registration never exposes a private alias of the same function", async (t) => {
  const f = await fixture(t);
  const shared = async () => {};
  f.handlers.set("fixture", shared);
  registerFileJobHandler(f.handlers, "size", shared, {
    public: true,
    validate: () => true,
  });
  await assert.rejects(
    f.jobs.start(f.globalScope, operation({ kind: "fixture" }), { publicOnly: true }),
    { code: "FILE_INVALID_OPERATION" },
  );
});

test("durable registration captures the validated operation before a snapshot wait", async (t) => {
  const f = await fixture(t);
  registerFileJobHandler(f.handlers, "size", async () => {}, {
    public: true,
    validate: (op) => Object.keys(op.options).length === 0,
  });
  const entered = deferred(),
    release = deferred();
  const holding = f.barrier.snapshot(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const op = operation();
  const started = f.jobs.start(f.globalScope, op, { publicOnly: true });
  op.options = { privateContents: "must not enter journal" };
  release.resolve();
  await holding;
  const job = await started;
  assert.deepEqual(f.store.getOperation(job.id).options, {});
});

test("publication retention ends only after an explicit resolved marker", async (t) => {
  const f = await fileFixture(t);
  let now = Date.now();
  const store = new FileStore({ dataDir: f.dataDir, now: () => now });
  t.after(() => store.close());
  const job = store.request(f.globalScope, operation()).job;
  store.transition(job.id, "queued", "completed", {});
  store.putPublication({
    id: "pending-adoption",
    jobId: job.id,
    phase: "published",
    document: { displacedPath: "private" },
  });
  now += 8 * 86400000;
  store.prune(now);
  assert.equal(store.getJob(f.globalScope, job.id).status, "completed");
  assert.equal(store.getPublication("pending-adoption").phase, "published");
  store.putPublication({
    id: "pending-adoption",
    jobId: job.id,
    phase: "resolved",
    document: {},
  });
  store.prune(now);
  assert.throws(() => store.getJob(f.globalScope, job.id), { code: "FILE_NOT_FOUND" });
  assert.equal(store.getPublication("pending-adoption"), null);
});

test("a retained terminal child pins its parent without cascading away recovery evidence", async (t) => {
  const f = await fileFixture(t);
  let now = Date.now();
  const store = new FileStore({ dataDir: f.dataDir, now: () => now });
  t.after(() => store.close());
  const parent = store.request(f.globalScope, operation()).job;
  const child = store.request(f.globalScope, operation({ parentJobId: parent.id })).job;
  for (const job of [parent, child]) store.transition(job.id, "queued", "completed", {});
  store.putPublication({
    id: "child-recovery",
    jobId: child.id,
    phase: "prepared",
    document: { identity: "retained" },
  });
  now += 8 * 86400000;
  store.prune(now);
  assert.equal(store.getJob(f.globalScope, parent.id).status, "completed");
  assert.equal(store.getJob(f.globalScope, child.id).status, "completed");
  assert.equal(store.getPublication("child-recovery").document.identity, "retained");
  store.putPublication({
    id: "child-recovery",
    jobId: child.id,
    phase: "resolved",
    document: {},
  });
  store.prune(now);
  assert.throws(() => store.getJob(f.globalScope, parent.id), { code: "FILE_NOT_FOUND" });
  assert.throws(() => store.getJob(f.globalScope, child.id), { code: "FILE_NOT_FOUND" });
});

test("cancellation settles a worker waiting behind a queued snapshot before handler entry", async (t) => {
  const f = await fixture(t, async () => assert.fail("cancelled handler entered"));
  let job, snapshot;
  await f.barrier.run(async () => {
    snapshot = f.barrier.detached(() => f.barrier.snapshot(() => {}));
    job = await f.jobs.start(f.globalScope, operation());
    await f.jobs.cancel(f.globalScope, job.id);
  });
  await snapshot;
  await settled(f.jobs, f.globalScope, job.id, "cancelled");
});
