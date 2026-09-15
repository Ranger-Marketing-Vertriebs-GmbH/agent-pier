import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable, PassThrough } from "node:stream";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";

async function group(f, entries) {
  const { groupId } = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  await f.uploads.appendGroup(f.scope, groupId, { batchId: "batch", entries });
  await f.uploads.commitGroup(f.scope, groupId);
  await f.jobs.join(f.scope, groupId);
  return groupId;
}
async function child(f, groupId, entryId) {
  const row = f.store.getEntry(groupId, entryId);
  return f.create(path.basename(row.path), row.bytes, {
    path: path.dirname(row.path),
    groupId,
    entryId,
  });
}
const file = (id, relativePath, bytes = 3) => ({ id, relativePath, type: "file", bytes });

test("three dormant groups use no slots and stable paged rows preserve directory structure", async (t) => {
  const f = await uploadFixture(t);
  const ids = [];
  for (let n = 0; n < 3; n++)
    ids.push(
      await group(f, [
        file("file", `folder${n}/child.txt`),
        { id: "empty", relativePath: `folder${n}/empty`, type: "directory", bytes: 0 },
      ]),
    );
  assert.equal(f.jobs.transfers, 0);
  for (const id of ids) {
    assert.equal(f.jobs.get(f.scope, id).status, "queued");
    const rows = f.jobs.entries(f.scope, id).entries;
    assert.equal(rows.length, 3);
    assert.equal(rows.find((row) => row.id === "file").status, "ready");
    const created = await child(f, id, "file");
    assert.equal(
      (
        await f.uploads.receive(
          f.scope,
          created.uploadId,
          Readable.from([Buffer.from("abc")]),
        )
      ).status,
      "completed",
    );
    await f.until(() => f.jobs.get(f.scope, id).status === "completed");
    assert.equal(await fs.readFile(f.store.getEntry(id, "file").path, "utf8"), "abc");
  }
});

test("batch replay is canonical, rejects changed content and Unicode/parent aliases", async (t) => {
  const f = await uploadFixture(t);
  const { groupId } = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  const batch = { batchId: "one", entries: [file("a", "Straße/a")] };
  assert.deepEqual(
    await f.uploads.appendGroup(f.scope, groupId, batch),
    await f.uploads.appendGroup(f.scope, groupId, batch),
  );
  await assert.rejects(
    f.uploads.appendGroup(f.scope, groupId, {
      ...batch,
      entries: [file("a", "different")],
    }),
    { code: "FILE_REQUEST_CONFLICT" },
  );
  await assert.rejects(
    f.uploads.appendGroup(f.scope, groupId, {
      batchId: "two",
      entries: [file("b", "STRASSE/b")],
    }),
    { code: "FILE_UPLOAD_ALIAS" },
  );
  for (const relativePath of ["../escape", "a//b", "a/./b", "/absolute", "bad\ud800"])
    await assert.rejects(
      f.uploads.appendGroup(f.scope, groupId, {
        batchId: "bad",
        entries: [file("b", relativePath)],
      }),
    );
  await assert.rejects(
    f.uploads.appendGroup(f.scope, groupId, {
      batchId: "three",
      entries: [file("c", "Straße/a/child")],
    }),
    { code: "FILE_UPLOAD_ALIAS" },
  );
});

test("partial retry keeps completed entries and cumulative byte costs", async (t) => {
  const f = await uploadFixture(t, { jobBytes: 8 });
  const id = await group(f, [file("a", "a"), file("b", "b")]);
  const first = await child(f, id, "a");
  await f.uploads.receive(f.scope, first.uploadId, Readable.from([Buffer.from("abc")]));
  const failed = await child(f, id, "b");
  assert.equal(
    (
      await f.uploads.receive(
        f.scope,
        failed.uploadId,
        Readable.from([Buffer.from("xy")]),
      )
    ).status,
    "failed",
  );
  await f.until(() => !f.jobs.owns(failed.uploadId));
  const retried = await child(f, id, "b");
  assert.notEqual(retried.uploadId, failed.uploadId);
  assert.equal(
    (
      await f.uploads.receive(
        f.scope,
        retried.uploadId,
        Readable.from([Buffer.from("def")]),
      )
    ).status,
    "completed",
  );
  await f.until(() => f.jobs.get(f.scope, id).status === "completed");
  assert.equal(f.store.uploads.group(id).attemptedBytes, 8);
  assert.equal(f.jobs.get(f.scope, id).completedBytes, 6);
  await assert.rejects(child(f, id, "a"), { code: "FILE_INVALID_OPERATION" });
});

test("concurrent retries cannot each pass the same stale parent budget", async (t) => {
  const f = await uploadFixture(t, { jobBytes: 8 });
  const id = await group(f, [file("a", "a"), file("b", "b")]);
  for (const entryId of ["a", "b"]) {
    const attempt = await child(f, id, entryId);
    await f.uploads.receive(
      f.scope,
      attempt.uploadId,
      Readable.from([Buffer.from("xy")]),
    );
    await f.until(() => !f.jobs.owns(attempt.uploadId));
  }
  const a = await child(f, id, "a"),
    b = await child(f, id, "b");
  const results = await Promise.all(
    [a, b].map((attempt) =>
      f.uploads.receive(f.scope, attempt.uploadId, Readable.from([Buffer.from("abc")])),
    ),
  );
  assert.deepEqual(results.map((job) => job.status).sort(), ["completed", "failed"]);
  assert.equal(f.store.uploads.group(id).attemptedBytes, 7);
});

test("directory Keep both remaps children using actual result and changed ready parents reject", async (t) => {
  const f = await uploadFixture(t);
  await fs.writeFile(path.join(f.home, "folder"), "occupied");
  const { groupId } = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  await f.uploads.appendGroup(f.scope, groupId, {
    batchId: "one",
    entries: [file("a", "folder/a")],
  });
  await f.uploads.commitGroup(f.scope, groupId);
  const conflict = await f.until(() =>
    f.jobs
      .list(f.scope)
      .jobs.find(
        (job) => job.kind === "create_directory" && job.status === "waiting_for_conflict",
      ),
  );
  await f.jobs.resolve(f.scope, conflict.id, {
    conflictId: conflict.conflict.id,
    decision: "keep_both",
    applyToRemaining: false,
  });
  await f.until(() => f.store.getEntry(groupId, "a").status === "ready");
  assert.equal(f.store.getEntry(groupId, "a").path, path.join(f.home, "folder (2)", "a"));
  const attempt = await child(f, groupId, "a");
  await fs.rename(path.join(f.home, "folder (2)"), path.join(f.home, "moved"));
  await fs.mkdir(path.join(f.home, "folder (2)"));
  await assert.rejects(
    f.uploads.receive(f.scope, attempt.uploadId, Readable.from([Buffer.from("abc")])),
    { code: "FILE_PATH_CHANGED" },
  );
  await assert.rejects(fs.stat(path.join(f.home, "folder (2)", "a")), { code: "ENOENT" });
});

test("group cancel preserves completed outputs and explicit retry never revives old children", async (t) => {
  const f = await uploadFixture(t);
  const id = await group(f, [file("a", "a"), file("b", "b")]);
  const a = await child(f, id, "a");
  await f.uploads.receive(f.scope, a.uploadId, Readable.from([Buffer.from("abc")]));
  const b = await child(f, id, "b"),
    stream = new PassThrough();
  const receiving = f.uploads.receive(f.scope, b.uploadId, stream);
  stream.write("x");
  await f.until(() => f.jobs.get(f.scope, b.uploadId).completedBytes === 1);
  await f.jobs.cancel(f.scope, id);
  await receiving;
  assert.equal(f.jobs.get(f.scope, id).status, "cancelled");
  const next = await child(f, id, "b");
  assert.notEqual(next.uploadId, b.uploadId);
  await f.uploads.receive(f.scope, next.uploadId, Readable.from([Buffer.from("def")]));
  await f.until(() => f.jobs.get(f.scope, id).status === "completed");
  assert.equal(f.jobs.get(f.scope, a.uploadId).status, "completed");
});

test("skipping a directory settles its already reserved descendants without byte admission", async (t) => {
  const f = await uploadFixture(t);
  await fs.writeFile(path.join(f.home, "folder"), "occupied");
  const { groupId } = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  await f.uploads.appendGroup(f.scope, groupId, {
    batchId: "one",
    entries: [file("a", "folder/a")],
  });
  await f.uploads.commitGroup(f.scope, groupId);
  const attempt = await child(f, groupId, "a");
  const conflict = await f.until(() =>
    f.jobs
      .list(f.scope)
      .jobs.find(
        (job) => job.kind === "create_directory" && job.status === "waiting_for_conflict",
      ),
  );
  await f.jobs.resolve(f.scope, conflict.id, {
    conflictId: conflict.conflict.id,
    decision: "skip",
    applyToRemaining: false,
  });
  await f.until(() => f.jobs.get(f.scope, groupId).status === "completed");
  assert.equal(f.jobs.get(f.scope, attempt.uploadId).status, "completed");
  assert.equal(f.store.getEntry(attempt.uploadId, "upload").status, "skipped");
  assert.equal(
    (
      await f.uploads.receive(
        f.scope,
        attempt.uploadId,
        Readable.from([Buffer.from("abc")]),
      )
    ).status,
    "completed",
  );
  assert.equal(f.store.uploads.group(groupId).attemptedBytes, 0);
});

test("manifest rows are bounded, paged and stable across append receipt replay", async (t) => {
  const f = await uploadFixture(t);
  const { groupId } = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  for (let batch = 0; batch < 3; batch++) {
    const entries = Array.from({ length: 80 }, (_, index) =>
      file(`id-${batch}-${index}`, `name-${batch}-${index}`, 0),
    );
    const receipt = await f.uploads.appendGroup(f.scope, groupId, {
      batchId: `batch-${batch}`,
      entries,
    });
    assert.equal(receipt.totalEntries, (batch + 1) * 80);
  }
  const first = f.jobs.entries(f.scope, groupId);
  assert.equal(first.entries.length, 200);
  assert.ok(first.nextCursor);
  const second = f.jobs.entries(f.scope, groupId, first.nextCursor);
  assert.equal(second.entries.length, 40);
  assert.equal(second.nextCursor, null);
  assert.equal(
    new Set([...first.entries, ...second.entries].map((row) => row.id)).size,
    240,
  );
  await assert.rejects(
    f.uploads.appendGroup(f.scope, groupId, {
      batchId: "oversized",
      entries: Array.from({ length: 600 }, (_, n) =>
        file(`extra-${n}`, `extra-${n}-${"x".repeat(100)}`),
      ),
    }),
    { code: "FILE_LIMIT_EXCEEDED" },
  );
  assert.equal(f.jobs.get(f.scope, groupId).totalEntries, 240);
});

test("implicit directories count against manifest limits and invalid commit creates nothing", async (t) => {
  for (const limits of [{ jobEntries: 2 }, { maxDepth: 2 }]) {
    const f = await uploadFixture(t, limits);
    const { groupId } = await f.uploads.createGroup(f.scope, {
      requestId: uploadRequest(),
      path: f.home,
    });
    await assert.rejects(
      f.uploads.appendGroup(f.scope, groupId, {
        batchId: "one",
        entries: [file("deep", "one/two/file")],
      }),
      { code: "FILE_LIMIT_EXCEEDED" },
    );
    await assert.rejects(f.uploads.commitGroup(f.scope, groupId), {
      code: "FILE_LIMIT_EXCEEDED",
    });
    assert.equal(f.jobs.entries(f.scope, groupId).entries.length, 0);
    await assert.rejects(fs.stat(path.join(f.home, "one")), { code: "ENOENT" });
  }
});

test("fresh file retry cannot bypass an unresolved directory publication", async (t) => {
  const f = await uploadFixture(t);
  const complete = f.store.completeTransfer.bind(f.store);
  f.store.completeTransfer = (record, ...args) => {
    if (record.document.type === "directory")
      throw new Error("simulated directory checkpoint crash");
    return complete(record, ...args);
  };
  const id = await group(f, [file("a", "parent/a")]);
  assert.equal(f.store.getEntry(id, "a").status, "failed");
  const unresolved = f.store
    .listPublications()
    .find((record) => record.phase !== "resolved");
  assert.ok(unresolved);
  await f.barrier.run(() => f.store.prune(Date.now() + 8 * 86400000));
  assert.equal(f.jobs.get(f.scope, unresolved.jobId).kind, "create_directory");
  await assert.rejects(child(f, id, "a"), { code: "FILE_UPLOAD_PENDING" });
  assert.equal(f.store.uploads.group(id).attemptedBytes, 0);
});

test("lost group-create response replays its identifier after the selected folder changes", async (t) => {
  const f = await uploadFixture(t),
    selected = path.join(f.home, "selected");
  await fs.mkdir(selected);
  const request = { requestId: uploadRequest(), path: selected };
  const first = await f.uploads.createGroup(f.scope, request);
  await fs.rename(selected, `${selected}-moved`);
  assert.equal((await f.uploads.createGroup(f.scope, request)).groupId, first.groupId);
  await assert.rejects(f.uploads.createGroup(f.scope, { ...request, path: f.home }), {
    code: "FILE_REQUEST_CONFLICT",
  });
});

test("actual directory remaps never silently coalesce distinct planned parents", async (t) => {
  const f = await uploadFixture(t);
  await fs.writeFile(path.join(f.home, "folder"), "occupied");
  const { groupId } = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  await f.uploads.appendGroup(f.scope, groupId, {
    batchId: "one",
    entries: [file("a", "folder/a"), file("b", "folder (2)/b")],
  });
  await f.uploads.commitGroup(f.scope, groupId);
  const conflict = await f.until(() =>
    f.jobs
      .list(f.scope)
      .jobs.find(
        (job) => job.kind === "create_directory" && job.status === "waiting_for_conflict",
      ),
  );
  await f.jobs.resolve(f.scope, conflict.id, {
    conflictId: conflict.conflict.id,
    decision: "keep_both",
    applyToRemaining: false,
  });
  await f.until(() => !f.jobs.owns(groupId));
  assert.equal(f.store.getEntry(groupId, "a").path, path.join(f.home, "folder (2)/a"));
  assert.equal(f.store.getEntry(groupId, "b").status, "failed");
  assert.equal(
    f.store.uploads.rowByPath(groupId, "folder (2)").issue.code,
    "FILE_UPLOAD_ALIAS",
  );
});
