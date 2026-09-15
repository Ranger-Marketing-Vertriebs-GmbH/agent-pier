import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture } from "../helpers/file-uploads.js";
import {
  extractionZip,
  extractOperation,
  resolveExtract,
} from "../helpers/file-extract.js";

for (const afterPublication of [false, true])
  test(`extraction cancellation ${afterPublication ? "after" : "before"} publication preserves exact entry results`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.home, "input.zip");
    await fs.writeFile(
      source,
      extractionZip([
        { name: "a", bytes: "first" },
        { name: "b", bytes: "second" },
      ]),
    );
    const entered = Promise.withResolvers(),
      release = Promise.withResolvers();
    const run = f.publisher.native.run.bind(f.publisher.native);
    let published = 0,
      paused = false;
    f.publisher.native.run = async (op, args) => {
      const result = await run(op, args);
      if (op === "renameNoReplace" && ["a", "b"].includes(args.newName)) published++;
      if (!paused && (afterPublication ? published && op === "read" : op === "write")) {
        paused = true;
        assert.equal(f.barrier.hasLease(), false);
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
    try {
      await entered.promise;
      await f.jobs.cancel(f.scope, job.id);
    } finally {
      release.resolve();
    }
    const result = await f.jobs.join(f.scope, job.id);
    assert.equal(
      result.status,
      afterPublication ? "partially_completed" : "cancelled",
      JSON.stringify(result),
    );
    assert.equal(published, afterPublication ? 1 : 0);
    assert.deepEqual(await fs.readdir(f.project), afterPublication ? ["a"] : []);
    assert.equal(result.completedEntries, published);
    assert.equal(result.completedBytes, afterPublication ? 5 : 0);
    assert.equal(
      f.jobs.entries(f.scope, job.id).entries.filter((row) => row.outputPublished).length,
      published,
    );
    assert.ok(
      f.jobs
        .entries(f.scope, job.id)
        .entries.every((row) => ["completed", "cancelled"].includes(row.status)),
    );
    await f.restart();
    assert.equal(f.jobs.get(f.scope, job.id).status, result.status);
    assert.deepEqual(await fs.readdir(f.project), afterPublication ? ["a"] : []);
  });

for (const replacement of [false, true])
  test(`recovery accounts ${replacement ? "exchanged" : "new"} extracted output without reading source or repeating publication`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.home, "input.zip");
    await fs.writeFile(source, extractionZip([{ name: "output", bytes: "new" }]));
    if (replacement) await fs.writeFile(path.join(f.project, "output"), "old");
    const complete = f.store.completeTransfer.bind(f.store);
    let failed = false;
    f.store.completeTransfer = (...args) => {
      if (args[0].document.extract && !failed) {
        failed = true;
        throw Error("checkpoint interrupted");
      }
      return complete(...args);
    };
    const operation = extractOperation(source, f.project),
      job = await f.jobs.start(f.scope, operation);
    if (replacement) await resolveExtract(f, job, "replace");
    assert.equal((await f.jobs.join(f.scope, job.id)).status, "failed");
    assert.equal(failed, true);
    const before = await fs.stat(path.join(f.project, "output"));
    await fs.unlink(source);
    await f.restart();
    assert.equal(f.jobs.get(f.scope, job.id).status, "partially_completed");
    assert.equal(f.jobs.get(f.scope, job.id).completedEntries, 1);
    assert.equal(f.jobs.entries(f.scope, job.id).entries[0].status, "completed");
    assert.equal((await fs.stat(path.join(f.project, "output"))).ino, before.ino);
    assert.equal((await f.jobs.start(f.scope, operation)).id, job.id);
    assert.equal((await f.trash.list(f.scope)).entries.length, replacement ? 1 : 0);
  });

test("a changed target-parent link invalidates proof before any output", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "input.zip");
  const alias = path.join(f.home, "alias"),
    elsewhere = path.join(f.home, "elsewhere");
  await fs.mkdir(elsewhere);
  await fs.symlink(f.project, alias);
  await fs.writeFile(source, extractionZip([{ name: "output", bytes: "new" }]));
  const run = f.publisher.native.run.bind(f.publisher.native);
  let changed = false;
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (!changed && op === "write") {
      changed = true;
      await fs.unlink(alias);
      await fs.symlink(elsewhere, alias);
    }
    return result;
  };
  const job = await f.jobs.start(f.scope, extractOperation(source, alias));
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "failed");
  assert.equal(changed, true);
  assert.deepEqual(await fs.readdir(f.project), []);
  assert.deepEqual(await fs.readdir(elsewhere), []);
});

test("unsupported filename evidence fails extraction while normal Explorer writes remain available", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "input.zip");
  await fs.writeFile(source, extractionZip([{ name: "output", bytes: "new" }]));
  const run = f.publisher.native.run.bind(f.publisher.native);
  f.publisher.native.run = (op, args) =>
    op === "namePolicy"
      ? Promise.reject(Object.assign(Error(), { code: "FILE_EXTRACT_UNSUPPORTED" }))
      : run(op, args);
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  assert.equal(
    (await f.jobs.join(f.scope, job.id)).issue.code,
    "FILE_EXTRACT_UNSUPPORTED",
  );
  assert.deepEqual(await fs.readdir(f.project), []);
  const ordinary = await f.jobs.start(f.scope, {
    ...extractOperation(source, f.project),
    kind: "create_file",
    sources: [],
    name: "ordinary",
  });
  assert.equal((await f.jobs.join(f.scope, ordinary.id)).status, "completed");
});
