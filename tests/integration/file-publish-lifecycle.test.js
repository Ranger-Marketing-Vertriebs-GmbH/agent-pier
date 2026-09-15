import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { fixture } from "../helpers/file-publisher.js";
import { fileFixture, seedFileJob } from "../helpers/file-explorer.js";
import { createFileServices } from "../../server/application/files.js";
import { MutationBarrier } from "../../server/application/mutation-barrier.js";

test("application closes outstanding stage descriptors before closing its store", async (t) => {
  const f = await fileFixture(t);
  const services = createFileServices({
    config: f,
    sessions: {},
    mutationBarrier: new MutationBarrier(),
  });
  t.after(() => services.close());
  assert.ok(
    services.publisher,
    "publication service must be composed into application lifecycle",
  );
  await services.ready;
  const job = seedFileJob(services.store, f.globalScope);
  const stage = await services.publisher.stage(f.globalScope, `${f.home}/new`, {
    jobId: job.id,
  });
  await stage.handle.writeFile("retained");
  await services.close();
  await assert.rejects(stage.handle.writeFile("late"), { code: "FILE_JOBS_CLOSED" });
  assert.equal(await fs.readFile(stage.file, "utf8"), "retained");
});

test("staging and revision hashing run outside physical barrier and path leases", async (t) => {
  const f = await fixture(t);
  const run = f.native.run.bind(f.native),
    reads = [];
  f.native.run = (op, args) => {
    if (["read", "copyMetadata", "write"].includes(op))
      reads.push([op, f.barrier.active > 0, f.locks.active.size > 0]);
    return run(op, args);
  };
  const stage = await f.stage();
  await stage.handle.writeFile("new");
  await f.publisher.publish(f.globalScope, stage, { expectedRevision: null });
  assert.ok(reads.some(([op]) => op === "read"));
  assert.ok(reads.every(([, barrier, lock]) => !barrier && !lock));
});

test("directory sync failure is durable interrupted state, never success", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.target, "original");
  const revision = await f.revision(),
    stage = await f.stage();
  await stage.handle.writeFile("new");
  const run = f.native.run.bind(f.native);
  let exchanged = false;
  f.native.run = async (op, args) => {
    if (op === "sync" && exchanged) throw Error("durability failure");
    const value = await run(op, args);
    if (op === "exchange") exchanged = true;
    return value;
  };
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
    { code: "FILE_IO_ERROR" },
  );
  assert.equal(f.store.getPublication(stage.id).phase, "interrupted");
  assert.equal(await fs.readFile(f.target, "utf8"), "new");
  assert.equal(await fs.readFile(stage.file, "utf8"), "original");
});

test("publisher shutdown drains every outstanding stage even when one close fails", async (t) => {
  const f = await fixture(t),
    first = await f.stage(),
    second = await f.stage();
  const run = f.native.run.bind(f.native);
  let failed = false;
  f.native.run = async (op, args) => {
    const result = await run(op, args);
    if (op === "closeHandle" && !failed) {
      failed = true;
      throw Error("close failed");
    }
    return result;
  };
  await assert.rejects(f.publisher.close());
  await assert.rejects(first.handle.stat(), { code: "FILE_JOBS_CLOSED" });
  await assert.rejects(second.handle.stat(), { code: "FILE_JOBS_CLOSED" });
  // The fixture's repeated close observes the same rejected draining promise.
  f.publisher.close = async () => {};
});

test("job shutdown closes the database after a publication cleanup failure", async (t) => {
  const f = await fileFixture(t);
  const { FileStore } = await import("../../server/features/files/file-store.js");
  const { FileJobs } = await import("../../server/features/files/file-jobs.js");
  const { PathLocks } = await import("../../server/features/files/file-locks.js");
  const store = new FileStore({ dataDir: f.dataDir });
  const jobs = new FileJobs({
    store,
    locks: new PathLocks(),
    barrier: new MutationBarrier(),
    handlers: new Map(),
    beforeStoreClose: async () => {
      throw Error("cleanup failure");
    },
  });
  t.after(() => store.close());
  await assert.rejects(jobs.close(), /cleanup failure/);
  assert.throws(() => store.listPublications(), /not open|closed/i);
});

test("partial stage creation failures close both owned parents without exhausting handle capacity", async (t) => {
  const f = await fixture(t),
    run = f.native.run.bind(f.native);
  let failures = 0;
  f.native.run = (op, args) => {
    if (op === "createFile") {
      failures++;
      throw Error("create failed");
    }
    return run(op, args);
  };
  for (let attempt = 0; attempt < 66; attempt++)
    await assert.rejects(f.stage(), { code: "FILE_IO_ERROR" });
  assert.equal(failures, 66);
  assert.equal(f.store.listPublications().length, 66);
  const parent = await f.native.run("openRoot", { path: f.home });
  await f.native.run("closeHandle", { handle: parent.handle });
});
