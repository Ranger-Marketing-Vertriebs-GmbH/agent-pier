import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { trashFixture } from "../helpers/file-trash.js";
import { trashAdoptionSource } from "../../server/features/files/file-trash-storage.js";

test("adoption drains an accepted pending stage write before judging pristine content", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let gate = false;
  const f = await trashFixture(t, async (op, args, run) => {
    if (op === "write" && gate) {
      entered.resolve();
      await release.promise;
    }
    return run(op, args);
  });
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const record = f.store.getTrash(id);
  record.phase = "restore_pending";
  f.store.putTrash(record);
  const source = await trashAdoptionSource(f.store, f.native, record);
  const stage = await f.stage();
  gate = true;
  const writing = stage.handle.writeFile("pending bytes");
  const writeResult = writing.then(
    () => true,
    (error) => error,
  );
  await entered.promise;
  const adopting = stage.adoptEntry(source);
  const outcome = adopting.then(
    () => true,
    (error) => error,
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    release.resolve();
    assert.equal(await writeResult, true);
    assert.notEqual(await outcome, true);
    assert.equal(await fs.readFile(stage.file, "utf8"), "pending bytes");
    assert.equal(await fs.readFile(record.location.file, "utf8"), "saved");
  } finally {
    release.resolve();
    await Promise.allSettled([writing, adopting]);
    await source.parentHandle.close();
  }
});

test("shutdown waits for an admitted trash listing before closing the store", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let gate = false;
  const f = await trashFixture(t, async (op, args, run) => {
    if (op === "openRoot" && gate) {
      entered.resolve();
      await release.promise;
    }
    return run(op, args);
  });
  await fs.writeFile(f.target, "saved");
  await f.trash.capture(f.globalScope, f.target, { jobId: f.jobId, reason: "deleted" });
  gate = true;
  const listing = f.trash.list(f.globalScope);
  await entered.promise;
  let closed = false;
  const close = f.trash.close().then(() => {
    closed = true;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(closed, false);
  } finally {
    release.resolve();
    await listing;
    await close;
  }
});

test("publication and transfer hashing run outside physical mutation and path leases", async (t) => {
  const f = await trashFixture(t, (op, args, run, fixture) => {
    if (["read", "copyMetadata", "write"].includes(op)) {
      assert.equal(fixture.barrier.active, 0);
      assert.equal(fixture.locks.active.size, 0);
    }
    return run(op, args);
  });
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  await f.trash.restore(f.globalScope, id, path.join(f.home, "restored"), {
    jobId: f.jobId,
    expectedRevision: null,
  });
});

test("a second mutation of one trash entry rejects while the first is still validating", async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  let gate = false;
  const f = await trashFixture(t, async (op, args, run) => {
    if (op === "openRoot" && gate) {
      entered.resolve();
      await release.promise;
    }
    return run(op, args);
  });
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  gate = true;
  const purge = f.trash.purge(f.globalScope, id, {
    jobId: f.jobId,
    confirmation: { id, revision: entry.revision },
  });
  const purgeOutcome = purge.then(
    () => true,
    (error) => error,
  );
  await entered.promise;
  const restore = f.trash.restore(f.globalScope, id, f.target, {
    jobId: f.jobId,
    expectedRevision: null,
  });
  const restoreOutcome = restore.then(
    () => "accepted",
    (error) => error.code,
  );
  try {
    assert.equal(
      await Promise.race([
        restoreOutcome,
        new Promise((resolve) => setTimeout(() => resolve("still running"), 30)),
      ]),
      "FILE_CONFLICT_CHANGED",
    );
  } finally {
    gate = false;
    release.resolve();
    await Promise.all([purgeOutcome, restoreOutcome]);
  }
});

test("repeated failed restore adoptions release native handles before the next operation", async (t) => {
  let fail = false;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "renameNoReplace" && fail && args.newName === "content")
      throw Object.assign(Error(), { code: "ENOSPC" });
    return run(op, args);
  });
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  for (let index = 0; index < 66; index++) {
    fail = true;
    await assert.rejects(
      f.trash.restore(f.globalScope, id, f.target, {
        jobId: f.jobId,
        expectedRevision: null,
      }),
    );
    fail = false;
    await f.trash.recover();
    assert.equal(
      (await f.trash.list(f.globalScope)).entries[0].availability,
      "recoverable",
      `iteration ${index}`,
    );
  }
  await f.trash.restore(f.globalScope, id, f.target, {
    jobId: f.jobId,
    expectedRevision: null,
  });
  assert.equal(await fs.readFile(f.target, "utf8"), "saved");
});

for (const boundary of ["missing", "renamed", "close_failure"])
  test(`failed clone replay drains owned handles after ${boundary}`, async (t) => {
    const live = new Set();
    let first = true,
      recovering = false,
      originalHandle,
      closeFailed = false;
    const f = await trashFixture(t, async (op, args, run, fixture) => {
      if (op === "renameNoReplace" && first) {
        first = false;
        throw Object.assign(Error(), { code: "EXDEV" });
      }
      if (op === "copyMetadata")
        throw Object.assign(Error(), { code: "FILE_METADATA_UNSUPPORTED", status: 409 });
      const result = await run(op, args);
      if (
        [
          "openRoot",
          "openLookup",
          "openFile",
          "openLink",
          "openDirectory",
          "createFile",
          "createDirectory",
        ].includes(op)
      ) {
        live.add(result.handle);
        if (
          recovering &&
          !originalHandle &&
          op === "openRoot" &&
          args.path === path.dirname(fixture.target)
        )
          originalHandle = result.handle;
      }
      if (op === "closeHandle") {
        live.delete(args.handle);
        if (
          boundary === "close_failure" &&
          recovering &&
          args.handle === originalHandle &&
          !closeFailed
        ) {
          closeFailed = true;
          throw Error("original close acknowledgement failed");
        }
      }
      return result;
    });
    await fs.writeFile(f.target, "original bytes");
    await assert.rejects(
      f.trash.capture(f.globalScope, f.target, {
        jobId: f.jobId,
        reason: "deleted",
      }),
    );
    const [entry] = (await f.trash.list(f.globalScope)).entries;
    const record = f.store.getTrash(entry.id);
    assert.equal(live.size, 0);
    if (boundary === "missing") await fs.unlink(record.location.file);
    if (boundary === "renamed") {
      await fs.rename(record.location.file, record.location.file + "-retained");
      await fs.writeFile(record.location.file, "external replacement");
    }
    recovering = true;
    await f.trash.recover();
    assert.equal(live.size, 0, "every acquired native handle must be drained");
    assert.equal(await fs.readFile(f.target, "utf8"), "original bytes");
    if (boundary === "close_failure") assert.equal(closeFailed, true);
    else {
      assert.ok(
        f.store.getTrash(entry.id),
        "uncertain registered payload remains pinned",
      );
      if (boundary === "renamed") {
        assert.equal(
          await fs.readFile(record.location.file, "utf8"),
          "external replacement",
        );
        assert.equal(
          await fs.readFile(record.location.file + "-retained", "utf8"),
          "original bytes",
        );
      }
      await f.trash.recover();
      assert.equal(live.size, 0);
    }
    const stage = await f.stage();
    await stage.handle.writeFile("subsequent legitimate operation");
    await f.publisher.release(stage);
    assert.equal(live.size, 0);
  });
