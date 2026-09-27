import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";

test(
  "descendant receive waits for the group generation that admits its retry",
  { timeout: 10000 },
  async (t) => {
    const release = Promise.withResolvers();
    t.after(() => release.resolve());
    const f = await uploadFixture(t);
    const { groupId } = await f.uploads.createGroup(f.scope, {
      requestId: uploadRequest(),
      path: f.home,
    });
    await f.uploads.appendGroup(f.scope, groupId, {
      batchId: "files",
      entries: [{ id: "file", relativePath: "folder/file", type: "file", bytes: 1 }],
    });
    await fs.writeFile(path.join(f.home, "folder"), "original");
    await f.uploads.commitGroup(f.scope, groupId);
    const conflict = await f.until(() =>
      f.jobs.list(f.scope).jobs.find((job) => job.status === "waiting_for_conflict"),
    );
    await f.jobs.cancel(f.scope, conflict.id);
    await f.jobs.join(f.scope, groupId);
    await f.until(() => !f.jobs.owns(groupId));
    assert.equal(f.store.getEntry(groupId, "file").status, "failed");
    await fs.rename(path.join(f.home, "folder"), path.join(f.home, "original"));

    // Hold the old coordinator after it has observed the failed directory. The
    // retry arrives before that generation relinquishes dispatcher ownership.
    const observed = Promise.withResolvers();
    const run = f.uploads.groups.run.bind(f.uploads.groups);
    let held = false;
    f.uploads.groups.run = async (context) => {
      const result = await run(context);
      if (!held) {
        held = true;
        observed.resolve();
        await release.promise;
      }
      return result;
    };
    await f.uploads.groups.wake(f.scope, groupId);
    await observed.promise;
    const { uploadId } = await f.create("file", 1, {
      path: path.join(f.home, "folder"),
      groupId,
      entryId: "file",
    });
    const joined = Promise.withResolvers();
    const wake = f.uploads.groups.wake.bind(f.uploads.groups);
    f.uploads.groups.wake = async (scope, id) => {
      await wake(scope, id);
      if (id === groupId) joined.resolve();
    };
    const receiving = f.uploads.receive(f.scope, uploadId, Readable.from(["b"]));
    await joined.promise;
    release.resolve();
    assert.equal((await receiving).status, "completed");
    assert.equal(await fs.readFile(path.join(f.home, "folder/file"), "utf8"), "b");
    assert.equal(await fs.readFile(path.join(f.home, "original"), "utf8"), "original");
  },
);

for (const disposition of ["cancel", "close"])
  test(
    `directory preparation releases receivers when groups ${disposition}`,
    { timeout: 10000 },
    async (t) => {
      const f = await uploadFixture(t);
      const { groupId } = await f.uploads.createGroup(f.scope, {
        requestId: uploadRequest(),
        path: f.home,
      });
      await f.uploads.appendGroup(f.scope, groupId, {
        batchId: "files",
        entries: [{ id: "file", relativePath: "folder/file", type: "file", bytes: 1 }],
      });
      await fs.writeFile(path.join(f.home, "folder"), "original");
      await f.uploads.commitGroup(f.scope, groupId);
      await f.until(() =>
        f.jobs.list(f.scope).jobs.some((job) => job.status === "waiting_for_conflict"),
      );
      const { uploadId } = await f.create("file", 1, {
        path: path.join(f.home, "folder"),
        groupId,
        entryId: "file",
      });
      const receiving = f.uploads.receive(f.scope, uploadId, Readable.from(["b"]));
      const rejected = assert.rejects(receiving, { code: "FILE_UPLOAD_PARENT" });
      await f.until(() => f.uploads.receivers.has(uploadId));
      if (disposition === "cancel") await f.jobs.cancel(f.scope, groupId);
      else await f.close();
      await rejected;
      assert.equal(f.uploads.receivers.size, 0);
      assert.equal(await fs.readFile(path.join(f.home, "folder"), "utf8"), "original");
    },
  );

test(
  "shutdown drains receive when coordinator admission is waiting for its mutation lease",
  { timeout: 10000 },
  async (t) => {
    const f = await uploadFixture(t);
    const { groupId } = await f.uploads.createGroup(f.scope, {
      requestId: uploadRequest(),
      path: f.home,
    });
    await f.uploads.appendGroup(f.scope, groupId, {
      batchId: "files",
      entries: [{ id: "file", relativePath: "file", type: "file", bytes: 1 }],
    });
    await f.uploads.commitGroup(f.scope, groupId);
    await f.until(() => !f.jobs.owns(groupId));
    const { uploadId } = await f.create("file", 1, { groupId, entryId: "file" });
    await f.until(() => !f.jobs.owns(groupId));
    const started = Promise.withResolvers();
    const wake = f.uploads.groups.wake.bind(f.uploads.groups);
    let closing;
    f.uploads.groups.wake = (scope, id) => {
      const preparing = wake(scope, id);
      // The lease acquisition yields before its callback. Shutdown wins that
      // handoff and must prevent a coordinator entering the closed dispatcher.
      closing = f.close();
      started.resolve();
      return preparing;
    };
    const receiving = f.uploads.receive(f.scope, uploadId, Readable.from(["b"]));
    const rejected = assert.rejects(receiving);
    const aborted = Promise.withResolvers();
    const abort = () => aborted.reject(t.signal.reason);
    t.signal.addEventListener("abort", abort, { once: true });
    if (t.signal.aborted) abort();
    try {
      await Promise.race([started.promise, aborted.promise]);
      await Promise.race([Promise.all([closing, rejected]), aborted.promise]);
      assert.equal(f.uploads.receivers.size, 0);
      assert.equal(f.uploads.groups.preparing.size, 0);
      await assert.rejects(fs.stat(path.join(f.home, "file")), { code: "ENOENT" });
    } finally {
      t.signal.removeEventListener("abort", abort);
      // Let fixture teardown finish even when the regression is present.
      f.uploads.groups.finishPreparation(groupId);
      await Promise.allSettled([closing, receiving, rejected]);
    }
  },
);
