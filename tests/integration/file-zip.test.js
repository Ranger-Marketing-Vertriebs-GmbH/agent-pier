import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture } from "../helpers/file-uploads.js";

import { zipEntries, archiveOperation, artifactBytes } from "../helpers/file-archives.js";

test("ZIP download round-trips Unicode, empty directories and forced ZIP64", async (t) => {
  const f = await uploadFixture(t);
  await fs.mkdir(path.join(f.project, "empty"));
  await fs.writeFile(path.join(f.project, "hällo.txt"), "hello");
  const job = await f.jobs.start(f.scope, archiveOperation([f.project]));
  const result = await f.jobs.join(f.scope, job.id);
  assert.equal(result.status, "completed", JSON.stringify(result));
  const bytes = await artifactBytes(f, job.id);
  assert.ok(bytes.includes(Buffer.from("504b0606", "hex")));
  const central = Buffer.from("504b0102", "hex");
  let zip64File = false;
  for (
    let offset = bytes.indexOf(central);
    offset !== -1;
    offset = bytes.indexOf(central, offset + 4)
  ) {
    const name = bytes
      .subarray(offset + 46, offset + 46 + bytes.readUInt16LE(offset + 28))
      .toString();
    if (name === "project/hällo.txt") {
      assert.equal(bytes.readUInt16LE(offset + 6), 45);
      assert.equal(bytes.readUInt32LE(offset + 24), 0xffffffff);
      zip64File = true;
    }
  }
  assert.equal(zip64File, true);
  const entries = await zipEntries(bytes);
  assert.equal(entries.get("project/hällo.txt").toString(), "hello");
  assert.ok(entries.has("project/empty/"));
});

test("duplicate roots reserve original names before generating alternates", async (t) => {
  const f = await uploadFixture(t),
    sources = [];
  for (const [parent, name, value] of [
    ["one", "a", "1"],
    ["two", "a", "2"],
    ["three", "a (2)", "3"],
  ]) {
    await fs.mkdir(path.join(f.home, parent));
    const source = path.join(f.home, parent, name);
    await fs.writeFile(source, value);
    sources.push(source);
  }
  const job = await f.jobs.start(f.scope, archiveOperation(sources));
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
  const entries = await zipEntries(await artifactBytes(f, job.id));
  assert.deepEqual([...entries.keys()], ["a", "a (3)", "a (2)"]);
  assert.deepEqual(
    [...entries.values()].map((b) => b.toString()),
    ["1", "2", "3"],
  );
});

test("missing selected child cannot disappear through parent deduplication", async (t) => {
  const f = await uploadFixture(t);
  await fs.writeFile(path.join(f.project, "exists"), "yes");
  const job = await f.jobs.start(
    f.scope,
    archiveOperation([f.project, path.join(f.project, "missing")]),
  );
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "failed");
  assert.equal(f.store.listPublications().length, 0);
  await assert.rejects(artifactBytes(f, job.id), { code: "FILE_ARCHIVE_PENDING" });
});

test("a source changed during consent cannot become a newly accepted source", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.project, "source");
  await fs.writeFile(source, "old");
  await fs.symlink(source, path.join(f.project, "link"));
  const job = await f.jobs.start(f.scope, archiveOperation([f.project]));
  const waiting = await f.until(() => {
    const j = f.jobs.get(f.scope, job.id);
    return j.conflict && j;
  });
  assert.equal(f.store.listPublications().length, 0);
  await fs.writeFile(source, "new");
  await f.jobs.resolve(f.scope, job.id, {
    conflictId: waiting.conflict.id,
    decision: "skip_links",
    applyToRemaining: false,
  });
  const result = await f.until(() => {
    const j = f.jobs.get(f.scope, job.id);
    return (
      (j.status === "failed" || (j.conflict && j.conflict.id !== waiting.conflict.id)) &&
      j
    );
  });
  assert.equal(result.status, "failed");
  assert.equal(f.store.listPublications().length, 0);
});

test("new omissions replace consent and reject old manifest page cursors without reading links", async (t) => {
  const f = await uploadFixture(t),
    sentinel = path.join(f.home, "sentinel");
  await fs.writeFile(sentinel, "must not read");
  for (let i = 0; i < 201; i++)
    await fs.symlink(sentinel, path.join(f.project, `link-${i}`));
  const native = f.publisher.native,
    run = native.run.bind(native);
  let sentinelOpens = 0;
  native.run = (op, args) => {
    if (op === "openFile" && args.path?.includes("sentinel")) sentinelOpens++;
    return run(op, args);
  };
  const job = await f.jobs.start(f.scope, archiveOperation([f.project]));
  let waiting = await f.until(() => {
    const j = f.jobs.get(f.scope, job.id);
    return j.conflict && j;
  });
  const first = f.jobs.entries(f.scope, job.id);
  assert.ok(first.nextCursor);
  const old = waiting.conflict;
  await fs.symlink(sentinel, path.join(f.project, "new-link"));
  await f.jobs.resolve(f.scope, job.id, {
    conflictId: old.id,
    decision: "skip_links",
    applyToRemaining: true,
  });
  waiting = await f.until(() => {
    const j = f.jobs.get(f.scope, job.id);
    return j.conflict?.id !== old.id && j.conflict && j;
  });
  assert.notEqual(waiting.conflict.manifestVersion, old.manifestVersion);
  assert.throws(() => f.jobs.entries(f.scope, job.id, first.nextCursor), {
    code: "FILE_INVALID_CURSOR",
  });
  assert.equal(f.store.listPublications().length, 0);
  await f.jobs.resolve(f.scope, job.id, {
    conflictId: waiting.conflict.id,
    decision: "skip_links",
    applyToRemaining: false,
  });
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
  assert.deepEqual(
    [...(await zipEntries(await artifactBytes(f, job.id))).keys()],
    ["project/"],
  );
  assert.equal(sentinelOpens, 0);
});

for (const suffix of ["/", "/."])
  test(`explicit directory link ending ${suffix} is omitted without following it`, async (t) => {
    const f = await uploadFixture(t),
      outside = path.join(f.home, "outside"),
      link = path.join(f.project, "link");
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret"), "must not read");
    await fs.symlink(outside, link);
    const job = await f.jobs.start(f.scope, archiveOperation([link + suffix]));
    const conflict = await f.until(() => f.jobs.get(f.scope, job.id).conflict);
    assert.equal(conflict.type, "archive_links");
    assert.equal(f.store.listPublications().length, 0);
    await f.jobs.resolve(f.scope, job.id, {
      conflictId: conflict.id,
      decision: "skip_links",
      applyToRemaining: false,
    });
    assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
    assert.equal((await zipEntries(await artifactBytes(f, job.id))).size, 0);
  });
