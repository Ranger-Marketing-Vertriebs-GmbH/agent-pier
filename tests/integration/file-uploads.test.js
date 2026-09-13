import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";

test("reservation is durable and lazy; actual bytes publish once", async (t) => {
  const f = await uploadFixture(t);
  const request = {
    requestId: uploadRequest(),
    path: f.home,
    name: "exact.bin",
    bytes: 131072,
  };
  const first = await f.uploads.create(f.scope, request);
  assert.deepEqual(await f.uploads.create(f.scope, request), first);
  assert.equal(f.store.listPublications().length, 0);
  assert.equal(f.jobs.transfers, 0);
  const bytes = Buffer.alloc(request.bytes, 123);
  const result = await f.uploads.receive(f.scope, first.uploadId, Readable.from([bytes]));
  assert.equal(result.status, "completed");
  assert.deepEqual(await fs.readFile(path.join(f.home, request.name)), bytes);
  const before = f.store.listPublications().length;
  assert.equal(
    (await f.uploads.receive(f.scope, first.uploadId, Readable.from([bytes]))).status,
    "completed",
  );
  assert.equal(f.store.listPublications().length, before);
});

test("aggregate manifest overflow refuses commit before visible directories", async (t) => {
  const f = await uploadFixture(t, { uploadBytes: 10, jobBytes: 15 });
  const { groupId } = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  await assert.rejects(
    f.uploads.appendGroup(f.scope, groupId, {
      batchId: "one",
      entries: [
        { id: "a", relativePath: "new/a", type: "file", bytes: 10 },
        { id: "b", relativePath: "new/b", type: "file", bytes: 10 },
      ],
    }),
    { code: "FILE_LIMIT_EXCEEDED" },
  );
  await assert.rejects(f.uploads.commitGroup(f.scope, groupId), {
    code: "FILE_LIMIT_EXCEEDED",
  });
  await assert.rejects(fs.stat(path.join(f.home, "new")), { code: "ENOENT" });
});

test("receiver backpressure releases physical snapshot leases and active sweep preserves bytes", async (t) => {
  const f = await uploadFixture(t);
  const { uploadId } = await f.create("paused", 6);
  const stream = new PassThrough();
  const receiving = f.uploads.receive(f.scope, uploadId, stream);
  stream.write(Buffer.from("one"));
  await f.until(() => f.jobs.get(f.scope, uploadId).completedBytes === 3);
  await f.barrier.snapshot(() => assert.equal(f.barrier.exclusive, true));
  await f.uploads.sweep(Date.now() + 2 * 86400000);
  stream.end(Buffer.from("two"));
  assert.equal((await receiving).status, "completed");
  assert.equal(await fs.readFile(path.join(f.home, "paused"), "utf8"), "onetwo");
});

test("native full disk fails the upload without publishing a final name", async (t) => {
  const f = await uploadFixture(t);
  const native = f.publisher.native,
    run = native.run.bind(native);
  native.run = (op, args) =>
    op === "write"
      ? Promise.reject(
          Object.assign(new Error("private disk evidence"), { code: "ENOSPC" }),
        )
      : run(op, args);
  const { uploadId } = await f.create("full", 3);
  const result = await f.uploads.receive(
    f.scope,
    uploadId,
    Readable.from([Buffer.from("abc")]),
  );
  assert.equal(result.status, "failed");
  await assert.rejects(fs.stat(path.join(f.home, "full")), { code: "ENOENT" });
  assert.ok(!JSON.stringify(result).includes("private disk evidence"));
});

test("declared and actual lengths, target changes and request metadata fail without replacing data", async (t) => {
  const f = await uploadFixture(t, { uploadBytes: 4 });
  await assert.rejects(f.create("too-large", 5), { code: "FILE_LIMIT_EXCEEDED" });
  const request = { requestId: uploadRequest(), path: f.home, name: "changed", bytes: 3 };
  const { uploadId } = await f.uploads.create(f.scope, request);
  await assert.rejects(f.uploads.create(f.scope, { ...request, bytes: 2 }), {
    code: "FILE_REQUEST_CONFLICT",
  });
  await assert.rejects(
    f.uploads.receive(f.scope, uploadId, Readable.from([]), { declaredBytes: 2 }),
    { code: "FILE_UPLOAD_LENGTH" },
  );
  await fs.writeFile(path.join(f.home, "changed"), "external");
  assert.equal(
    (await f.uploads.receive(f.scope, uploadId, Readable.from([Buffer.from("abc")])))
      .status,
    "failed",
  );
  assert.equal(await fs.readFile(path.join(f.home, "changed"), "utf8"), "external");
  const overflow = await f.create("overflow", 3);
  const result = await f.uploads.receive(
    f.scope,
    overflow.uploadId,
    Readable.from([Buffer.from("abcde")]),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.issue.code, "FILE_LIMIT_EXCEEDED");
  await assert.rejects(fs.stat(path.join(f.home, "overflow")), { code: "ENOENT" });
});

test("skipped standalone upload replays its completed disposition without creating a writer", async (t) => {
  const f = await uploadFixture(t);
  await fs.writeFile(path.join(f.home, "skip"), "existing");
  const { uploadId } = await f.create("skip", 3);
  const receiving = f.uploads.receive(
    f.scope,
    uploadId,
    Readable.from([Buffer.from("abc")]),
  );
  const job = await f.until(() => {
    const job = f.jobs.get(f.scope, uploadId);
    return job.conflict && job;
  });
  await f.jobs.resolve(f.scope, uploadId, {
    conflictId: job.conflict.id,
    decision: "skip",
    applyToRemaining: false,
  });
  assert.equal((await receiving).status, "completed");
  assert.equal(
    (await f.uploads.receive(f.scope, uploadId, Readable.from([Buffer.from("abc")])))
      .status,
    "completed",
  );
  assert.equal(f.store.listPublications().length, 0);
  assert.equal(await fs.readFile(path.join(f.home, "skip"), "utf8"), "existing");
});

for (const grouped of [false, true])
  test(`global ${grouped ? "group" : "standalone"} upload preserves symlink-dot-dot destination semantics`, async (t) => {
    const f = await uploadFixture(t),
      actual = path.join(f.home, "actual"),
      shadow = path.join(f.home, "lexical-shadow");
    await fs.mkdir(path.join(actual, "inner"), { recursive: true });
    await fs.mkdir(shadow);
    await fs.writeFile(path.join(shadow, "sentinel"), "untouched");
    await fs.symlink(path.join(actual, "inner"), path.join(shadow, "alias"));
    const selected = `${shadow}/alias/..`;
    let request = {
      requestId: uploadRequest(),
      path: selected,
      name: "uploaded",
      bytes: 3,
    };
    if (grouped) {
      const { groupId } = await f.uploads.createGroup(f.scope, {
        requestId: uploadRequest(),
        path: selected,
      });
      await f.uploads.appendGroup(f.scope, groupId, {
        batchId: "one",
        entries: [
          { id: "file", relativePath: "folder/uploaded", type: "file", bytes: 3 },
        ],
      });
      await f.uploads.commitGroup(f.scope, groupId);
      await f.jobs.join(f.scope, groupId);
      const row = f.store.getEntry(groupId, "file");
      request = { ...request, path: path.dirname(row.path), groupId, entryId: row.id };
    }
    const { uploadId } = await f.uploads.create(f.scope, request);
    assert.equal(
      (await f.uploads.receive(f.scope, uploadId, Readable.from([Buffer.from("abc")])))
        .status,
      "completed",
    );
    assert.equal(
      await fs.readFile(
        path.join(actual, grouped ? "folder/uploaded" : "uploaded"),
        "utf8",
      ),
      "abc",
    );
    await assert.rejects(fs.stat(path.join(shadow, grouped ? "folder" : "uploaded")), {
      code: "ENOENT",
    });
    assert.equal(await fs.readFile(path.join(shadow, "sentinel"), "utf8"), "untouched");
  });

test("upload revalidates the original parent spelling after bytes arrive", async (t) => {
  const f = await uploadFixture(t);
  await fs.mkdir(path.join(f.home, "first"));
  await fs.mkdir(path.join(f.home, "second"));
  const alias = path.join(f.home, "alias");
  await fs.symlink(path.join(f.home, "first"), alias);
  const { uploadId } = await f.create("file", 6, { path: alias });
  const stream = new PassThrough(),
    receiving = f.uploads.receive(f.scope, uploadId, stream);
  stream.write("abc");
  await f.until(() => f.jobs.get(f.scope, uploadId).completedBytes === 3);
  await fs.unlink(alias);
  await fs.symlink(path.join(f.home, "second"), alias);
  stream.end("def");
  assert.equal((await receiving).status, "failed");
  for (const name of ["first", "second"])
    await assert.rejects(fs.stat(path.join(f.home, name, "file")), { code: "ENOENT" });
});
