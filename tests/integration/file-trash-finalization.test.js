import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { trashFixture } from "../helpers/file-trash.js";

async function captured(f) {
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  return { id, entry };
}

test("purge replay consumes removed-container evidence and finishes other registered locations", async (t) => {
  const f = await trashFixture(t),
    { id, entry } = await captured(f);
  const remove = f.store.deleteTrash.bind(f.store);
  let fail = true;
  f.store.deleteTrash = (value) => {
    if (fail) throw Error("final deletion failed");
    return remove(value);
  };
  await assert.rejects(
    f.trash.purge(f.globalScope, id, {
      jobId: f.jobId,
      confirmation: { id, revision: entry.revision },
    }),
  );
  const record = f.store.getTrash(id);
  assert.equal(record.location.containerRemoved, true);
  const replaced = path.dirname(record.location.file);
  await fs.mkdir(replaced);
  await fs.writeFile(path.join(replaced, "external"), "unrelated");
  const extra = path.join(f.home, "registered-empty");
  await fs.mkdir(extra);
  const stat = await fs.stat(extra, { bigint: true });
  record.extraLocations = [
    { file: path.join(extra, "payload"), parentIdentity: `${stat.dev}:${stat.ino}` },
  ];
  f.store.putTrash(record);
  fail = false;
  await f.trash.recover();
  await f.trash.recover();
  assert.equal(f.store.getTrash(id), null);
  await assert.rejects(fs.stat(extra), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(replaced, "external"), "utf8"), "unrelated");
});

test("discard replay finishes after a durable container marker and failed record deletion", async (t) => {
  let first = true;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "renameNoReplace" && first) {
      first = false;
      throw Object.assign(Error(), { code: "EXDEV" });
    }
    if (op === "copyMetadata")
      throw Object.assign(Error(), { code: "FILE_METADATA_UNSUPPORTED", status: 409 });
    return run(op, args);
  });
  await fs.writeFile(f.target, "original");
  await assert.rejects(
    f.trash.capture(f.globalScope, f.target, { jobId: f.jobId, reason: "deleted" }),
  );
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  const remove = f.store.deleteTrash.bind(f.store);
  let fail = true;
  f.store.deleteTrash = (value) => {
    if (fail) throw Error("discard final deletion failed");
    return remove(value);
  };
  await f.trash.recover();
  const record = f.store.getTrash(entry.id);
  assert.equal(record.phase, "discarding");
  assert.equal(record.location.containerRemoved, true);
  fail = false;
  await f.trash.recover();
  assert.equal(f.store.getTrash(entry.id), null);
  assert.equal(await fs.readFile(f.target, "utf8"), "original");
});

async function displaced(f) {
  await fs.writeFile(f.target, "old");
  const revision = await f.revision();
  const stage = await f.stage();
  await stage.handle.writeFile("new");
  const result = await f.publisher.publish(f.globalScope, stage, {
    expectedRevision: revision,
  });
  return { id: result.recoveryId, stage };
}

for (const boundary of [
  "normal",
  "pending_direct",
  "replay",
  "recoverable",
  "recoverable_replay",
  "trash_final",
])
  test(`adoption resumes ${boundary} publication finalization without deleting a recreated stage`, async (t) => {
    const f = await trashFixture(t),
      { id, stage } = await displaced(f);
    const putTrash = f.store.putTrash.bind(f.store),
      putPublication = f.store.putPublication.bind(f.store);
    let failMoved = boundary === "replay",
      failPublication = !["replay", "trash_final"].includes(boundary),
      failTrashFinal = boundary === "trash_final",
      failedPublication = false;
    f.store.putTrash = (record) => {
      if (record.id === id && record.adoptionComplete && failTrashFinal) {
        failTrashFinal = false;
        throw Error("final trash journal failed");
      }
      if (record.id === id && record.phase === "moved" && failMoved) {
        failMoved = false;
        throw Error("moved journal failed");
      }
      if (
        boundary.startsWith("recoverable") &&
        failedPublication &&
        record.phase === "adoption_pending"
      )
        throw Error("pending journal failed");
      return putTrash(record);
    };
    f.store.putPublication = (record) => {
      if (record.id === id && record.phase === "resolved" && failPublication) {
        failedPublication = true;
        throw Error("publication finalization failed");
      }
      return putPublication(record);
    };
    await assert.rejects(f.trash.adoptDisplaced(f.globalScope, id));
    if (boundary === "replay") {
      failPublication = true;
      await f.trash.recover();
    }
    if (boundary.startsWith("recoverable"))
      assert.equal(f.store.getTrash(id).phase, "recoverable");
    if (boundary !== "trash_final")
      assert.notEqual(f.store.getPublication(id).phase, "resolved");
    const oldDirectory = path.dirname(stage.file);
    await fs.mkdir(oldDirectory);
    await fs.writeFile(path.join(oldDirectory, "external"), "external bytes");
    if (boundary === "pending_direct") {
      const pending = f.store.getTrash(id);
      await assert.rejects(f.trash.adoptDisplaced(f.globalScope, id));
      assert.deepEqual(f.store.getTrash(id), pending);
    }
    failPublication = false;
    failedPublication = false;
    if (boundary === "pending_direct") {
      const pending = f.store.getTrash(id);
      assert.equal(pending.phase, "adoption_pending");
      assert.equal(pending.adoptionSource.containerRemoved, true);
      const result = await f.trash.adoptDisplaced(f.globalScope, id).then(
        (value) => value,
        (error) => error.code,
      );
      assert.deepEqual(f.store.getTrash(id).location, pending.location);
      assert.deepEqual(f.store.getTrash(id).adoptionSource, pending.adoptionSource);
      assert.equal(result, id);
    } else if (boundary === "recoverable")
      await f.trash.adoptDisplaced(f.globalScope, id);
    else await f.trash.recover();
    await f.trash.recover();
    assert.equal(f.store.getTrash(id).phase, "recoverable");
    assert.equal(f.store.getPublication(id).phase, "resolved");
    assert.equal(
      await fs.readFile(path.join(oldDirectory, "external"), "utf8"),
      "external bytes",
    );
    assert.equal(await fs.readFile(f.store.getTrash(id).location.file, "utf8"), "old");
    assert.equal(await fs.readFile(f.target, "utf8"), "new");
  });

test("purge keeps an unfinished adoption location pinned across a replacement", async (t) => {
  let blockedContainer,
    cleanupFailed = false;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "removeEntry" && args.name === blockedContainer) {
      cleanupFailed = true;
      throw Object.assign(Error(), { code: "EACCES" });
    }
    return run(op, args);
  });
  const { id, stage } = await displaced(f);
  const oldDirectory = path.dirname(stage.file);
  blockedContainer = path.basename(oldDirectory);
  const putTrash = f.store.putTrash.bind(f.store);
  let failPending = true;
  f.store.putTrash = (record) => {
    if (record.phase === "adoption_pending" && cleanupFailed && failPending)
      throw Error("pending disposition failed");
    return putTrash(record);
  };
  await assert.rejects(f.trash.adoptDisplaced(f.globalScope, id));
  assert.equal(f.store.getTrash(id).phase, "recoverable");
  failPending = false;
  blockedContainer = null;
  await fs.rename(oldDirectory, oldDirectory + "-retained");
  await fs.mkdir(oldDirectory);
  await fs.writeFile(path.join(oldDirectory, "external"), "external bytes");
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  await assert.rejects(
    f.trash.purge(f.globalScope, id, {
      jobId: f.jobId,
      confirmation: { id, revision: entry.revision },
    }),
  );
  await f.trash.recover();
  assert.equal(f.store.getTrash(id).location.containerRemoved, true);
  assert.notEqual(f.store.getPublication(id).phase, "resolved");
  assert.equal(
    await fs.readFile(path.join(oldDirectory, "external"), "utf8"),
    "external bytes",
  );
  await fs.unlink(path.join(oldDirectory, "external"));
  await fs.rmdir(oldDirectory);
  await fs.rename(oldDirectory + "-retained", oldDirectory);
  await f.trash.recover();
  assert.equal(f.store.getTrash(id), null);
  assert.equal(f.store.getPublication(id).phase, "resolved");
  assert.equal(await fs.readFile(f.target, "utf8"), "new");
});

test("direct retry preserves incomplete moved evidence for verified replay", async (t) => {
  const f = await trashFixture(t),
    { id } = await displaced(f);
  const putTrash = f.store.putTrash.bind(f.store);
  let fail = true;
  f.store.putTrash = (record) => {
    if (record.id === id && record.phase === "moved" && fail) {
      fail = false;
      throw Error("moved journal failed");
    }
    return putTrash(record);
  };
  await assert.rejects(f.trash.adoptDisplaced(f.globalScope, id));
  const pending = f.store.getTrash(id);
  assert.equal(pending.phase, "adoption_pending");
  assert.equal(pending.payloadManifest, undefined);
  await assert.rejects(f.trash.adoptDisplaced(f.globalScope, id), {
    code: "FILE_CONFLICT_CHANGED",
  });
  assert.deepEqual(f.store.getTrash(id), pending);
  await f.trash.recover();
  assert.equal(f.store.getTrash(id).phase, "recoverable");
  assert.equal(f.store.getPublication(id).phase, "resolved");
  assert.equal(await fs.readFile(pending.location.file, "utf8"), "old");
  assert.equal(await fs.readFile(f.target, "utf8"), "new");
});
