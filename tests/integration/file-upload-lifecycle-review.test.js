import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";

const file = (id, relativePath, bytes) => ({ id, relativePath, type: "file", bytes });
const directory = (id, relativePath) => ({
  id,
  relativePath,
  type: "directory",
  bytes: 0,
});
async function group(f, entries, destination = f.home) {
  const { groupId } = await f.uploads.createGroup(f.scope, {
    requestId: uploadRequest(),
    path: destination,
  });
  await f.uploads.appendGroup(f.scope, groupId, { batchId: "files", entries });
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
async function promptly(promise) {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(1500, null, { signal: timer.signal }).then(() =>
        assert.fail("owned work did not settle without additional client input"),
      ),
    ]);
  } finally {
    timer.abort();
  }
}
function retentionEvidence(f, child, jobId, pruneAt) {
  const db = f.store.db;
  return JSON.stringify({
    child,
    pruneAt,
    retained:
      db
        .prepare("SELECT status,updated_at AS updatedAt FROM jobs WHERE id=?")
        .get(jobId) ?? null,
    owned: f.jobs.owns(jobId),
    publications: db.prepare("SELECT phase FROM publications WHERE job_id=?").all(jobId),
    pins: db
      .prepare(
        "SELECT (SELECT count(*) FROM trash_entries WHERE job_id=?) AS trash, (SELECT count(*) FROM jobs WHERE parent_job_id=?) AS children",
      )
      .get(jobId, jobId),
  });
}

test("blocked nested manifest settles after explicit directory IDs reorder its rows", async (t) => {
  const f = await uploadFixture(t),
    destination = path.join(f.home, "selected");
  await fs.mkdir(destination);
  const id = await group(f, [file("file", "a/b/file", 1)], destination);
  await f.uploads.appendGroup(f.scope, id, {
    batchId: "directories",
    entries: [directory("a", "a"), directory("b", "a/b")],
  });
  assert.deepEqual(
    f.jobs.entries(f.scope, id).entries.map((row) => row.id),
    ["file", "a", "b"],
  );
  await fs.rename(destination, `${destination}-moved`);
  await fs.mkdir(destination);
  await f.uploads.commitGroup(f.scope, id);
  await f.jobs.join(f.scope, id);
  await f.until(() => !f.jobs.owns(id));
  assert.equal(f.jobs.get(f.scope, id).status, "failed");
  assert.deepEqual(
    f.jobs.entries(f.scope, id).entries.map((row) => [row.id, row.status]),
    [
      ["file", "failed"],
      ["a", "failed"],
      ["b", "failed"],
    ],
  );
  assert.equal(f.store.getEntry(id, "file").issue.code, "FILE_UPLOAD_PARENT");
  assert.equal(f.jobs.pending.length, 0);
  assert.equal(f.jobs.transfers, 0);
  assert.deepEqual(await fs.readdir(destination), []);
});

test("pruned completed child cannot prevent cancellation and drainage of a live sibling", async (t) => {
  const f = await uploadFixture(t),
    id = await group(f, [file("done", "done", 1), file("live", "live", 2)]);
  await f.uploads.commitGroup(f.scope, id);
  await f.jobs.join(f.scope, id);
  const done = await child(f, id, "done");
  await f.uploads.receive(f.scope, done.uploadId, Readable.from([Buffer.from("a")]));
  await f.until(() => !f.jobs.owns(done.uploadId));
  const live = await child(f, id, "live"),
    stream = new PassThrough();
  const receiving = f.uploads.receive(f.scope, live.uploadId, stream);
  try {
    stream.write("b");
    await f.until(() => f.jobs.get(f.scope, live.uploadId).completedBytes === 1);
    const controller = f.jobs.active.get(live.uploadId).controller;
    await f.barrier.run(() => f.store.prune(Date.now() + 8 * 86400000));
    assert.throws(() => f.jobs.get(f.scope, done.uploadId), { code: "FILE_NOT_FOUND" });
    assert.equal((await promptly(f.jobs.cancel(f.scope, id))).status, "cancelled");
    assert.equal((await promptly(receiving)).status, "cancelled");
    assert.equal(controller.signal.aborted, true);
    assert.equal(f.jobs.transfers, 0);
    assert.equal(f.store.getEntry(id, "done").status, "completed");
    assert.equal(await fs.readFile(path.join(f.home, "done"), "utf8"), "a");
  } finally {
    stream.end("c");
    await receiving;
  }
});

for (const timing of ["before", "after"])
  test(`group cancellation drains directory admission held ${timing} the actual start`, async (t) => {
    const f = await uploadFixture(t),
      id = await group(f, [file("file", "folder/file", 1)]);
    await fs.writeFile(path.join(f.home, "folder"), "original");
    const start = f.jobs.start.bind(f.jobs),
      entered = Promise.withResolvers(),
      release = Promise.withResolvers(),
      returned = Promise.withResolvers();
    let directoryChild,
      cancelling,
      cancelSettled = false;
    f.jobs.start = async (...args) => {
      if (args[1].kind !== "create_directory" || args[1].parentJobId !== id)
        return start(...args);
      try {
        if (timing === "before") {
          entered.resolve();
          await release.promise;
        }
        directoryChild = await start(...args);
        if (timing === "after") {
          entered.resolve();
          await release.promise;
        }
        return directoryChild;
      } finally {
        returned.resolve();
      }
    };
    await f.uploads.commitGroup(f.scope, id);
    try {
      await promptly(entered.promise);
      let controller;
      if (timing === "after") {
        await f.until(
          () => f.jobs.get(f.scope, directoryChild.id).status === "waiting_for_conflict",
        );
        controller = f.jobs.active.get(directoryChild.id).controller;
      }
      cancelling = f.jobs.cancel(f.scope, id);
      cancelling.then(
        () => {
          cancelSettled = true;
        },
        () => {
          cancelSettled = true;
        },
      );
      await f.until(() => f.jobs.active.get(id)?.controller.signal.aborted);
      await delay(30);
      assert.equal(
        cancelSettled,
        false,
        "cancellation must retain coordinator ownership through the admission handoff",
      );
      assert.equal(f.jobs.get(f.scope, id).status, "cancelling");
      if (controller) assert.equal(controller.signal.aborted, true);
      release.resolve();
      assert.equal((await promptly(cancelling)).status, "cancelled");
      assert.equal(f.jobs.owns(id), false);
      assert.equal(f.jobs.workers.size, 0);
      assert.equal(
        f.jobs.entries(f.scope, id).entries.every((row) => row.status === "cancelled"),
        true,
      );
      if (timing === "before") {
        assert.equal(directoryChild, undefined);
        assert.equal(
          f.jobs.list(f.scope).jobs.some((job) => job.kind === "create_directory"),
          false,
          "cancelled admission must roll back its durable job and row claim",
        );
      } else assert.equal(f.jobs.get(f.scope, directoryChild.id).status, "cancelled");
      assert.equal(await fs.readFile(path.join(f.home, "folder"), "utf8"), "original");
    } finally {
      release.resolve();
      await promptly(returned.promise);
      if (directoryChild) await f.jobs.cancel(f.scope, directoryChild.id);
      await Promise.allSettled([cancelling, f.jobs.join(f.scope, id)]);
    }
  });

for (const failing of ["native write", "progress persistence"])
  test(`paused upload fails and releases its slot when ${failing} rejects`, async (t) => {
    const f = await uploadFixture(t),
      failed = Promise.withResolvers();
    let writes = 0;
    const native = f.publisher.native,
      run = native.run.bind(native);
    native.run = (operation, args) => {
      if (operation === "write") {
        writes++;
        if (failing === "native write") {
          failed.resolve();
          return Promise.reject(
            Object.assign(new Error("fixture full disk"), { code: "ENOSPC" }),
          );
        }
      }
      return run(operation, args);
    };
    if (failing === "progress persistence")
      f.store.uploads.charge = () => {
        failed.resolve();
        throw Object.assign(new Error("fixture progress persistence failure"), {
          code: "SQLITE_FULL",
        });
      };
    const { uploadId } = await f.create("failed", 2),
      stream = new PassThrough();
    const receiving = f.uploads.receive(f.scope, uploadId, stream);
    try {
      stream.write("a");
      await promptly(failed.promise);
      const job = await promptly(receiving);
      assert.equal(job.status, "failed");
      assert.equal(stream.destroyed, true);
      assert.equal(f.jobs.transfers, 0);
      assert.equal(f.jobs.active.size, 0);
      assert.equal(f.store.listPublications().at(-1).phase, "resolved");
      if (failing === "progress persistence") assert.equal(writes, 0);
      await assert.rejects(fs.stat(path.join(f.home, "failed")), { code: "ENOENT" });
    } finally {
      stream.end();
      await receiving;
    }
  });

test("progress failure stops input immediately but retains the slot until the owned write drains", async (t) => {
  const f = await uploadFixture(t),
    writing = Promise.withResolvers(),
    release = Promise.withResolvers(),
    failed = Promise.withResolvers();
  const native = f.publisher.native,
    run = native.run.bind(native),
    charge = f.store.uploads.charge.bind(f.store.uploads);
  native.run = async (operation, args) => {
    if (operation === "write") {
      writing.resolve();
      await release.promise;
    }
    return run(operation, args);
  };
  let charged = 0,
    settled = false;
  f.store.uploads.charge = (...args) => {
    if (++charged === 2) {
      failed.resolve();
      throw new Error("fixture second report failure");
    }
    return charge(...args);
  };
  const { uploadId } = await f.create("draining", 3),
    stream = new PassThrough();
  const receiving = f.uploads.receive(f.scope, uploadId, stream);
  receiving.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  try {
    stream.write("a");
    await promptly(writing.promise);
    stream.write("b");
    await promptly(failed.promise);
    await f.until(() => stream.destroyed);
    assert.equal(settled, false);
    assert.equal(f.jobs.transfers, 1);
    await f.barrier.snapshot(() => {});
    release.resolve();
    assert.equal((await promptly(receiving)).status, "failed");
    assert.equal(f.jobs.transfers, 0);
    assert.equal(f.store.listPublications().at(-1).phase, "resolved");
  } finally {
    release.resolve();
    stream.end();
    await receiving;
  }
});

for (const disposition of ["failed", "interrupted"])
  test(`fresh retry survives a pruned ${disposition} child without resetting its group budget`, async (t) => {
    const f = await uploadFixture(t, { jobBytes: 6 }),
      id = await group(f, [
        file("done", "done", 1),
        file("retry", "retry", 2),
        file("live", "live", 2),
      ]);
    await f.uploads.commitGroup(f.scope, id);
    await f.jobs.join(f.scope, id);
    const done = await child(f, id, "done");
    const completed = await f.uploads.receive(
      f.scope,
      done.uploadId,
      Readable.from([Buffer.from("a")]),
    );
    assert.equal(
      completed.status,
      "completed",
      `retention setup must complete done: ${JSON.stringify(completed.issue)}`,
    );
    let prior = await child(f, id, "retry");
    assert.equal(
      (
        await f.uploads.receive(
          f.scope,
          prior.uploadId,
          Readable.from([Buffer.from("b")]),
        )
      ).status,
      "failed",
    );
    await f.until(() => !f.jobs.owns(prior.uploadId));
    if (disposition === "interrupted") {
      prior = await child(f, id, "retry");
      await f.restart();
    }
    assert.equal(f.jobs.get(f.scope, prior.uploadId).status, disposition);
    const live = await child(f, id, "live"),
      stream = new PassThrough();
    const receiving = f.uploads.receive(f.scope, live.uploadId, stream);
    try {
      stream.write("c");
      await f.until(() => f.jobs.get(f.scope, live.uploadId).completedBytes === 1);
      const charged = f.store.uploads.group(id).attemptedBytes;
      assert.equal(charged, 3);
      const pruneAt = await f.barrier.run(() => {
        const at = Date.now() + 8 * 86400000;
        f.store.prune(at);
        return at;
      });
      for (const [label, old] of [
        ["done", done],
        ["prior", prior],
      ])
        assert.throws(
          () => f.jobs.get(f.scope, old.uploadId),
          { code: "FILE_NOT_FOUND" },
          retentionEvidence(f, label, old.uploadId, pruneAt),
        );
      // A retained in-memory owner must still block admission even if durable
      // metadata is absent; restore the actual dispatcher before the real retry.
      const owns = f.jobs.owns.bind(f.jobs);
      f.jobs.owns = (jobId) => jobId === prior.uploadId || owns(jobId);
      let ownedError;
      try {
        await child(f, id, "retry");
      } catch (error) {
        ownedError = error;
      } finally {
        f.jobs.owns = owns;
      }
      assert.equal(f.store.getEntry(id, "retry").currentJobId, prior.uploadId);
      const retried = await child(f, id, "retry");
      assert.equal(ownedError?.code, "FILE_UPLOAD_PENDING");
      assert.notEqual(retried.uploadId, prior.uploadId);
      assert.equal(f.store.uploads.group(id).attemptedBytes, charged);
      assert.equal(
        (
          await f.uploads.receive(
            f.scope,
            retried.uploadId,
            Readable.from([Buffer.from("de")]),
          )
        ).status,
        "completed",
      );
      assert.equal(f.store.uploads.group(id).attemptedBytes, charged + 2);
      await assert.rejects(child(f, id, "done"), { code: "FILE_INVALID_OPERATION" });
      assert.equal(await fs.readFile(path.join(f.home, "done"), "utf8"), "a");
      assert.equal(await fs.readFile(path.join(f.home, "retry"), "utf8"), "de");
    } finally {
      stream.end("f");
      await receiving;
    }
    await f.until(() => f.jobs.get(f.scope, id).status === "completed");
    assert.equal(f.store.uploads.group(id).attemptedBytes, 6);
    assert.equal(f.jobs.get(f.scope, id).completedBytes, 5);
  });

test("explicit descendant retry replaces a pruned failed directory child through normal admission", async (t) => {
  const f = await uploadFixture(t),
    id = await group(f, [file("retry", "folder/file", 1), file("live", "live", 2)]);
  await fs.writeFile(path.join(f.home, "folder"), "original");
  await f.uploads.commitGroup(f.scope, id);
  const prior = await f.until(() =>
    f.jobs.list(f.scope).jobs.find((job) => job.status === "waiting_for_conflict"),
  );
  await f.jobs.cancel(f.scope, prior.id);
  await f.jobs.join(f.scope, id);
  await f.until(() => !f.jobs.owns(id));
  assert.equal(f.store.uploads.rowByPath(id, "folder").status, "failed");
  assert.equal(f.store.getEntry(id, "retry").status, "failed");
  const live = await child(f, id, "live"),
    stream = new PassThrough();
  const receiving = f.uploads.receive(f.scope, live.uploadId, stream);
  try {
    stream.write("a");
    await f.until(() => f.jobs.get(f.scope, live.uploadId).completedBytes === 1);
    await f.barrier.run(() => f.store.prune(Date.now() + 8 * 86400000));
    assert.throws(() => f.jobs.get(f.scope, prior.id), { code: "FILE_NOT_FOUND" });
    await fs.rename(path.join(f.home, "folder"), path.join(f.home, "original"));
    const retried = await child(f, id, "retry");
    assert.equal(
      (
        await f.uploads.receive(
          f.scope,
          retried.uploadId,
          Readable.from([Buffer.from("b")]),
        )
      ).status,
      "completed",
    );
    const directory = f.store.uploads.rowByPath(id, "folder");
    assert.equal(directory.status, "completed");
    assert.notEqual(directory.currentJobId, prior.id);
    assert.equal(f.jobs.get(f.scope, directory.currentJobId).kind, "create_directory");
    assert.equal(await fs.readFile(path.join(f.home, "folder/file"), "utf8"), "b");
    assert.equal(await fs.readFile(path.join(f.home, "original"), "utf8"), "original");
    assert.equal(f.store.uploads.group(id).attemptedBytes, 2);
  } finally {
    stream.end("c");
    await receiving;
  }
  await f.until(() => f.jobs.get(f.scope, id).status === "completed");
});
