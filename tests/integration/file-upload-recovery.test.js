import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";

test("received-stream mismatch retains observed modified owned payload during sweep", async (t) => {
  const f = await uploadFixture(t);
  const native = f.publisher.native,
    run = native.run.bind(native);
  native.run = async (op, args) => {
    const result = await run(op, args);
    if (op === "write") {
      const record = f.store.listPublications().find((item) => item.document.upload);
      await fs.writeFile(record.document.staged, "xyz");
    }
    return result;
  };
  const { uploadId } = await f.create("changed", 3);
  const result = await f.uploads.receive(
    f.scope,
    uploadId,
    Readable.from([Buffer.from("abc")]),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.issue.code, "FILE_UPLOAD_CHANGED");
  native.run = run;
  const record = f.store.listPublications().find((item) => item.jobId === uploadId);
  assert.equal(await fs.readFile(record.document.staged, "utf8"), "xyz");
  await f.uploads.sweep(Date.now() + 2 * 86400000);
  assert.equal(await fs.readFile(record.document.staged, "utf8"), "xyz");
  assert.notEqual(f.store.getPublication(record.id).phase, "resolved");
  await assert.rejects(fs.stat(path.join(f.home, "changed")), { code: "ENOENT" });
});

test("expired partial cleanup uses last activity and preserves an externally replaced payload", async (t) => {
  const f = await uploadFixture(t);
  const discard = f.publisher.discard.bind(f.publisher);
  f.publisher.discard = async () => {
    throw new Error("simulated unavailable cleanup");
  };
  const records = [];
  for (const name of ["old", "replaced"]) {
    const { uploadId } = await f.create(name, 4);
    const result = await f.uploads.receive(
      f.scope,
      uploadId,
      Readable.from([Buffer.from("abc")]),
    );
    assert.equal(result.status, "failed");
    records.push(f.store.listPublications().find((row) => row.jobId === uploadId));
  }
  f.publisher.discard = discard;
  const [old, replaced] = records;
  await fs.rename(replaced.document.staged, `${replaced.document.staged}.saved`);
  await fs.writeFile(replaced.document.staged, "replacement");
  const activity = f.store.uploads.attempt(old.jobId).lastActivity;
  await f.uploads.sweep(activity + 86400000 - 1);
  assert.equal(await fs.readFile(old.document.staged, "utf8"), "abc");
  await f.uploads.sweep(activity + 86400001);
  await assert.rejects(fs.stat(old.document.staged), { code: "ENOENT" });
  assert.equal(f.store.getPublication(old.id).phase, "resolved");
  assert.equal(await fs.readFile(replaced.document.staged, "utf8"), "replacement");
  assert.notEqual(f.store.getPublication(replaced.id).phase, "resolved");
});

test("restart proves publication once and repairs child/group completion without receiving bytes", async (t) => {
  const f = await uploadFixture(t);
  const group = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  await f.uploads.appendGroup(f.scope, group.groupId, {
    batchId: "one",
    entries: [{ id: "file", relativePath: "published", type: "file", bytes: 3 }],
  });
  await f.uploads.commitGroup(f.scope, group.groupId);
  const request = {
    requestId: uploadRequest(),
    path: f.home,
    name: "published",
    bytes: 3,
    groupId: group.groupId,
    entryId: "file",
  };
  const { uploadId } = await f.uploads.create(f.scope, request);
  const updateRow = f.store.uploads.updateRow.bind(f.store.uploads);
  f.store.uploads.updateRow = (id, patch) => {
    updateRow(id, patch);
    if (patch.outputPublished) throw new Error("simulated checkpoint transaction crash");
  };
  assert.equal(
    (await f.uploads.receive(f.scope, uploadId, Readable.from([Buffer.from("abc")])))
      .status,
    "failed",
  );
  assert.equal(await fs.readFile(path.join(f.home, "published"), "utf8"), "abc");
  assert.equal(f.store.uploads.attempt(uploadId).published, undefined);
  assert.equal(f.store.getEntry(group.groupId, "file").outputPublished, undefined);
  assert.equal(
    f.store.listPublications().find((row) => row.jobId === uploadId).document
      .uploadCompleted,
    undefined,
  );
  await f.until(() => !f.jobs.owns(uploadId));
  await f.barrier.run(() => f.store.prune(Date.now() + 8 * 86400000));
  assert.equal(f.jobs.get(f.scope, uploadId).status, "failed");
  await assert.rejects(
    f.uploads.create(f.scope, { ...request, requestId: uploadRequest() }),
    { code: "FILE_UPLOAD_PENDING" },
  );
  assert.equal(f.store.uploads.group(group.groupId).attemptedBytes, 3);
  await f.restart();
  assert.equal(f.jobs.get(f.scope, uploadId).status, "completed");
  assert.equal(f.store.getEntry(group.groupId, "file").status, "completed");
  assert.equal(f.jobs.get(f.scope, group.groupId).status, "completed");
  assert.equal((await f.uploads.create(f.scope, request)).uploadId, uploadId);
  assert.equal(
    (
      await f.uploads.receive(
        f.scope,
        uploadId,
        Readable.from([Buffer.from("different")]),
      )
    ).status,
    "completed",
  );
  assert.equal(await fs.readFile(path.join(f.home, "published"), "utf8"), "abc");
  assert.equal(f.jobs.transfers, 0);
});

test("restart interrupts unfinished manifests and old reservations; only fresh children retry", async (t) => {
  const f = await uploadFixture(t);
  const { groupId } = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  await f.uploads.appendGroup(f.scope, groupId, {
    batchId: "one",
    entries: [
      { id: "unfinished", relativePath: "unfinished", type: "file", bytes: 3 },
      { id: "unattempted", relativePath: "unattempted", type: "file", bytes: 0 },
    ],
  });
  await f.uploads.commitGroup(f.scope, groupId);
  const request = {
    requestId: uploadRequest(),
    path: f.home,
    name: "unfinished",
    bytes: 3,
    groupId,
    entryId: "unfinished",
  };
  const { uploadId } = await f.uploads.create(f.scope, request);
  await f.restart();
  assert.equal(f.jobs.get(f.scope, uploadId).status, "interrupted");
  assert.equal(f.store.getEntry(groupId, "unattempted").status, "interrupted");
  assert.equal((await f.uploads.create(f.scope, request)).uploadId, uploadId);
  await assert.rejects(f.uploads.receive(f.scope, uploadId, Readable.from([])), {
    code: "FILE_UPLOAD_PENDING",
  });
  const fresh = await f.uploads.create(f.scope, {
    ...request,
    requestId: uploadRequest(),
  });
  assert.notEqual(fresh.uploadId, uploadId);
  assert.equal(
    (
      await f.uploads.receive(
        f.scope,
        fresh.uploadId,
        Readable.from([Buffer.from("abc")]),
      )
    ).status,
    "completed",
  );
  await f.until(() => !f.jobs.owns(groupId));
  assert.equal(f.store.getEntry(groupId, "unattempted").status, "interrupted");
});

test("duplicate concurrent content joins original receiver and disconnect drains owned writes", async (t) => {
  const f = await uploadFixture(t);
  const { uploadId } = await f.create("disconnect", 6);
  const stream = new PassThrough(),
    controller = new AbortController();
  const first = f.uploads.receive(f.scope, uploadId, stream, {
    signal: controller.signal,
  });
  stream.write("abc");
  await f.until(() => f.jobs.get(f.scope, uploadId).completedBytes === 3);
  const duplicate = f.uploads.receive(
    f.scope,
    uploadId,
    Readable.from([Buffer.from("badbad")]),
  );
  controller.abort();
  assert.equal((await first).status, "cancelled");
  assert.equal((await duplicate).status, "cancelled");
  assert.equal(f.jobs.transfers, 0);
  assert.equal(f.store.uploads.attempt(uploadId).received, 3);
  await assert.rejects(fs.stat(path.join(f.home, "disconnect")), { code: "ENOENT" });
  assert.equal(f.store.listPublications().at(-1).phase, "resolved");
});
