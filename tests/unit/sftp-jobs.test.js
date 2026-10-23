import test from "node:test";
import assert from "node:assert/strict";
import { SftpJobs } from "../../server/features/sftp/sftp-jobs.js";
import { sftpProblem } from "../../server/features/sftp/sftp-errors.js";

// A run that ends when its signal aborts, or when `finish` is called.
function controllable() {
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  const calls = {};
  const run = (progress, signal) => {
    calls.progress = progress;
    calls.signal = signal;
    return Promise.race([
      done,
      new Promise((resolve) =>
        signal.addEventListener("abort", () => resolve({ state: "cancelled" }), {
          once: true,
        }),
      ),
    ]);
  };
  return { run, finish, calls };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("limit per owner", async (t) => {
  const jobs = new SftpJobs({ limit: 2 });
  t.after(() => jobs.closeAll());
  const first = controllable();
  const a = jobs.start("alice", { kind: "upload", run: first.run });
  jobs.start("alice", { kind: "upload", run: controllable().run });
  assert.throws(() => jobs.start("alice", { kind: "upload", run: controllable().run }), {
    code: "SFTP_BUSY",
    status: 429,
  });
  jobs.start("bob", { kind: "download", run: controllable().run });
  assert.equal(a.state, "running");
  first.finish({ state: "completed", files: 1 });
  const ended = await jobs.wait("alice", a.jobId, 1000);
  assert.equal(ended.state, "completed");
  assert.deepEqual(ended.result, { state: "completed", files: 1 });
  jobs.start("alice", { kind: "sync", run: controllable().run });
});

test("other owner cannot read", async (t) => {
  const jobs = new SftpJobs();
  t.after(() => jobs.closeAll());
  const job = jobs.start("alice", {
    kind: "upload",
    summary: { files: 2 },
    run: controllable().run,
  });
  assert.deepEqual(jobs.get("alice", job.jobId), {
    jobId: job.jobId,
    kind: "upload",
    summary: { files: 2 },
    state: "running",
    progress: { files: 0, filesDone: 0, bytes: 0, bytesDone: 0, current: null },
  });
  for (const call of [
    () => jobs.get("bob", job.jobId),
    () => jobs.cancel("bob", job.jobId),
    () => jobs.wait("bob", job.jobId, 10),
    () => jobs.get("alice", "missing"),
  ])
    assert.throws(call, { code: "SFTP_JOB_NOT_FOUND", status: 404 });
  assert.equal(jobs.get("alice", job.jobId).state, "running");
});

test("cancel aborts the run and the job ends cancelled", async (t) => {
  const jobs = new SftpJobs();
  t.after(() => jobs.closeAll());
  const run = controllable();
  const job = jobs.start("alice", { kind: "upload", run: run.run });
  await tick();
  jobs.cancel("alice", job.jobId);
  assert.equal(run.calls.signal.aborted, true);
  assert.equal((await jobs.wait("alice", job.jobId, 1000)).state, "cancelled");
});

test("progress throttled to 1/s", async (t) => {
  let clock = 10_000;
  const jobs = new SftpJobs({ now: () => clock });
  t.after(() => jobs.closeAll());
  const heard = [];
  jobs.onProgress((view, owner) =>
    heard.push([owner, view.state, view.progress.filesDone]),
  );
  const run = controllable();
  const job = jobs.start("alice", { kind: "upload", run: run.run });
  await tick();
  for (let i = 1; i <= 5; i++) run.calls.progress({ filesDone: i, files: 9 });
  clock += 500;
  run.calls.progress({ filesDone: 6 });
  clock += 600;
  run.calls.progress({ filesDone: 7, ignored: true });
  assert.deepEqual(heard, [
    ["alice", "running", 1],
    ["alice", "running", 7],
  ]);
  assert.equal(jobs.get("alice", job.jobId).progress.files, 9);
  run.finish({ state: "completed" });
  await jobs.wait("alice", job.jobId, 1000);
  assert.deepEqual(heard.at(-1), ["alice", "completed", 7]);
});

test("job times out after jobMs", async (t) => {
  const jobs = new SftpJobs({ jobMs: 30 });
  t.after(() => jobs.closeAll());
  const run = controllable();
  const job = jobs.start("alice", { kind: "sync", run: run.run });
  const ended = await jobs.wait("alice", job.jobId, 2000);
  assert.equal(ended.state, "failed");
  assert.equal(ended.result.code, "SFTP_TIMEOUT");
  assert.equal(run.calls.signal.aborted, true);
  await tick();
  assert.equal(
    jobs.get("alice", job.jobId).state,
    "failed",
    "the late result is ignored",
  );
});

test("a failing run ends failed with its code; ended jobs expire after keepMs", async (t) => {
  let clock = 0;
  const jobs = new SftpJobs({ now: () => clock, keepMs: 1000 });
  t.after(() => jobs.closeAll());
  const job = jobs.start("alice", {
    kind: "upload",
    run: async () => {
      throw sftpProblem("SFTP_PERMISSION");
    },
  });
  const ended = await jobs.wait("alice", job.jobId, 1000);
  assert.equal(ended.state, "failed");
  assert.equal(ended.result.code, "SFTP_PERMISSION");
  const other = jobs.start("alice", {
    kind: "upload",
    run: async () => {
      throw new Error("/secret/path leaked");
    },
  });
  assert.deepEqual((await jobs.wait("alice", other.jobId, 1000)).result, {
    state: "failed",
    code: "SFTP_FAILED",
  });
  clock += 1001;
  assert.throws(() => jobs.get("alice", job.jobId), { code: "SFTP_JOB_NOT_FOUND" });
});

test("wait returns the running job after ms; closeAll cancels", async () => {
  const jobs = new SftpJobs();
  const run = controllable();
  const job = jobs.start("alice", { kind: "upload", run: run.run });
  assert.equal((await jobs.wait("alice", job.jobId, 10)).state, "running");
  jobs.closeAll();
  assert.equal(jobs.get("alice", job.jobId).state, "cancelled");
  assert.equal(run.calls.signal.aborted, true);
});

test("a timed-out job keeps its slot until its run settles", async (t) => {
  const jobs = new SftpJobs({ limit: 1, jobMs: 20 });
  t.after(() => jobs.closeAll());
  let release;
  const stuck = jobs.start("alice", {
    kind: "upload",
    // Ignores its signal for a while, as a cleanup still running would.
    run: () => new Promise((resolve) => (release = resolve)),
  });
  assert.equal((await jobs.wait("alice", stuck.jobId, 1000)).state, "failed");
  assert.throws(() => jobs.start("alice", { kind: "upload", run: controllable().run }), {
    code: "SFTP_BUSY",
  });
  release({ state: "completed" });
  await tick();
  jobs.start("alice", { kind: "upload", run: controllable().run });
});

test("two syncs into the same folder never run at once", async (t) => {
  const jobs = new SftpJobs({ limit: 5 });
  t.after(() => jobs.closeAll());
  const write = (path, hostId = "h1") => ({ hostId, path, write: true });
  const first = controllable();
  const sync = jobs.start("alice", { kind: "sync", run: first.run, lock: write("/www") });
  for (const [owner, lock] of [
    ["alice", write("/www")],
    ["bob", write("/www/sub")],
    ["alice", write("/")],
  ])
    assert.throws(
      () => jobs.start(owner, { kind: "sync", run: controllable().run, lock }),
      {
        code: "SFTP_BUSY",
      },
    );
  jobs.start("alice", { kind: "sync", run: controllable().run, lock: write("/www2") });
  jobs.start("alice", {
    kind: "sync",
    run: controllable().run,
    lock: write("/www", "h2"),
  });
  jobs.start("alice", {
    kind: "download",
    run: controllable().run,
    lock: { hostId: "h1", path: "/www", write: false },
  });
  first.finish({ state: "completed" });
  await jobs.wait("alice", sync.jobId, 1000);
  await tick();
  jobs.start("bob", { kind: "sync", run: controllable().run, lock: write("/www/sub") });
});
