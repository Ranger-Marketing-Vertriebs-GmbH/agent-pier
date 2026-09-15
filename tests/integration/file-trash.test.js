import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { trashFixture } from "../helpers/file-trash.js";

test("trash renames the inode into private storage and restores its bytes", async (t) => {
  const f = await trashFixture(t);
  await fs.writeFile(f.target, "important");
  const before = await fs.lstat(f.target);
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  await assert.rejects(fs.lstat(f.target), { code: "ENOENT" });
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  assert.equal(entry.id, id);
  assert.equal(entry.availability, "recoverable");
  assert.match(entry.revision, /^t1:/);
  const payload = path.join(f.dataDir, "files", "trash", id, "payload");
  assert.equal((await fs.lstat(payload)).ino, before.ino);
  assert.equal(await fs.readFile(payload, "utf8"), "important");
  await f.trash.restore(f.globalScope, id, f.target, {
    jobId: f.jobId,
    expectedRevision: null,
  });
  assert.equal(await fs.readFile(f.target, "utf8"), "important");
  assert.deepEqual((await f.trash.list(f.globalScope)).entries, []);
});

test("trash storage failure retains the source, with no permanent-delete fallback", async (t) => {
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "renameNoReplace") throw Object.assign(Error(), { code: "ENOSPC" });
    return run(op, args);
  });
  await fs.writeFile(f.target, "keep");
  await assert.rejects(
    f.trash.capture(f.globalScope, f.target, { jobId: f.jobId, reason: "deleted" }),
  );
  assert.equal(await fs.readFile(f.target, "utf8"), "keep");
});

test("trash moves only a selected link, and project lists include only current bounds", async (t) => {
  const f = await trashFixture(t);
  await fs.writeFile(f.target, "outside data");
  const link = path.join(f.project, "link");
  await fs.symlink(f.target, link);
  const id = await f.trash.capture(f.globalScope, link, {
    jobId: f.jobId,
    reason: "deleted",
  });
  assert.equal(await fs.readFile(f.target, "utf8"), "outside data");
  assert.equal(
    await fs.readlink(path.join(f.dataDir, "files", "trash", id, "payload")),
    f.target,
  );
  const visible = (await f.trash.list(f.projectScope)).entries;
  assert.equal(visible.length, 1);
  assert.equal(visible[0].originalPath, "link");
  await f.trash.capture(f.globalScope, f.target, { jobId: f.jobId, reason: "deleted" });
  assert.equal((await f.trash.list(f.projectScope)).entries.length, 1);
  assert.equal((await f.trash.list(f.globalScope)).entries.length, 2);
});

test("purge requires the selected current revision and preserves observed replacements", async (t) => {
  const f = await trashFixture(t);
  await fs.writeFile(f.target, "keep");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const [entry] = (await f.trash.list(f.globalScope)).entries;
  await assert.rejects(
    f.trash.purge(f.globalScope, id, {
      jobId: f.jobId,
      confirmation: { id, revision: "stale" },
    }),
  );
  const payload = path.join(f.dataDir, "files", "trash", id, "payload");
  await fs.rename(payload, `${payload}-retained`);
  await fs.writeFile(payload, "external");
  await assert.rejects(
    f.trash.purge(f.globalScope, id, {
      jobId: f.jobId,
      confirmation: { id, revision: entry.revision },
    }),
  );
  assert.equal(await fs.readFile(payload, "utf8"), "external");
  assert.equal(await fs.readFile(`${payload}-retained`, "utf8"), "keep");
});

test("EXDEV uses strict transfer or retains Linux source when completeness is unavailable", async (t) => {
  let first = true;
  const f = await trashFixture(t, (op, args, run) => {
    if (op === "renameNoReplace" && first) {
      first = false;
      throw Object.assign(Error(), { code: "EXDEV" });
    }
    return run(op, args);
  });
  await fs.writeFile(f.target, "cross-device");
  const capture = f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  if (process.platform === "linux") {
    await assert.rejects(capture, { code: "FILE_METADATA_UNSUPPORTED" });
    assert.equal(await fs.readFile(f.target, "utf8"), "cross-device");
  } else {
    const id = await capture;
    assert.equal(
      await fs.readFile(path.join(f.dataDir, "files", "trash", id, "payload"), "utf8"),
      "cross-device",
    );
    await assert.rejects(fs.lstat(f.target), { code: "ENOENT" });
  }
});

test("restore refuses escaping or missing project parents without moving payload bytes", async (t) => {
  const f = await trashFixture(t);
  const nested = path.join(f.project, "nested");
  await fs.mkdir(nested);
  const source = path.join(nested, "keep");
  await fs.writeFile(source, "scoped");
  const id = await f.trash.capture(f.globalScope, source, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const { seedFileJob } = await import("../helpers/file-explorer.js");
  const jobId = seedFileJob(f.store, f.projectScope).id;
  await fs.rmdir(nested);
  await assert.rejects(
    f.trash.restore(f.projectScope, id, "nested/keep", { jobId, expectedRevision: null }),
  );
  await fs.symlink(f.home, nested);
  await assert.rejects(
    f.trash.restore(f.projectScope, id, "nested/keep", { jobId, expectedRevision: null }),
    { code: "FILE_OUTSIDE_SCOPE" },
  );
  assert.equal(
    await fs.readFile(path.join(f.dataDir, "files", "trash", id, "payload"), "utf8"),
    "scoped",
  );
  assert.equal(
    (await f.trash.list({ ...f.projectScope, root: path.join(f.home, "different") }))
      .entries.length,
    0,
  );
});

test("stage adoption refuses written content and observed source replacement", async (t) => {
  const f = await trashFixture(t);
  await fs.writeFile(f.target, "saved");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  const record = f.store.getTrash(id);
  record.phase = "restore_pending";
  f.store.putTrash(record);
  const { trashAdoptionSource } =
    await import("../../server/features/files/file-trash-storage.js");
  const source = await trashAdoptionSource(f.store, f.native, record);
  try {
    const written = await f.stage();
    await written.handle.writeFile("already written");
    await assert.rejects(written.adoptEntry(source));
    assert.equal(await fs.readFile(written.file, "utf8"), "already written");
    const empty = await f.stage();
    await fs.rename(record.location.file, `${record.location.file}-retained`);
    await fs.writeFile(record.location.file, "external");
    await assert.rejects(empty.adoptEntry(source));
    assert.equal(await fs.readFile(record.location.file, "utf8"), "external");
    assert.equal(await fs.readFile(`${record.location.file}-retained`, "utf8"), "saved");
  } finally {
    await source.parentHandle.close();
  }
});

test("restore preserves original inode and mode for a complete directory tree", async (t) => {
  const f = await trashFixture(t);
  await fs.mkdir(f.target, { mode: 0o750 });
  await fs.writeFile(path.join(f.target, "keep"), "saved", { mode: 0o640 });
  const before = await fs.lstat(path.join(f.target, "keep"));
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  await f.trash.restore(f.globalScope, id, f.target, {
    jobId: f.jobId,
    expectedRevision: null,
  });
  const after = await fs.lstat(path.join(f.target, "keep"));
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode, before.mode);
  assert.equal(await fs.readFile(path.join(f.target, "keep"), "utf8"), "saved");
});

test("trash refuses active publication work and restore refuses private storage targets", async (t) => {
  const f = await trashFixture(t);
  const stage = await f.stage();
  await stage.handle.writeFile("working bytes");
  await assert.rejects(
    f.trash.capture(f.globalScope, stage.file, { jobId: f.jobId, reason: "deleted" }),
    { code: "FILE_PROTECTED_PATH" },
  );
  await fs.writeFile(f.target, "original");
  const id = await f.trash.capture(f.globalScope, f.target, {
    jobId: f.jobId,
    reason: "deleted",
  });
  await assert.rejects(
    f.trash.restore(
      f.globalScope,
      id,
      path.join(f.dataDir, "files", "trash", "external"),
      { jobId: f.jobId, expectedRevision: null },
    ),
    { code: "FILE_PROTECTED_PATH" },
  );
  assert.equal(await fs.readFile(stage.file, "utf8"), "working bytes");
});

test("a changed moved tree is retained as interrupted instead of silently accepted", async (t) => {
  const f = await trashFixture(t, async (op, args, run, fixture) => {
    const result = await run(op, args);
    if (op === "renameNoReplace" && args.newName === "payload") {
      const [record] = fixture.store.listTrashRecords(fixture.globalScope).entries;
      await fs.writeFile(path.join(record.location.file, "child"), "after!");
      await fs.utimes(path.join(record.location.file, "child"), 1234567890, 1234567890);
    }
    return result;
  });
  await fs.mkdir(f.target);
  await fs.writeFile(path.join(f.target, "child"), "before");
  await fs.utimes(path.join(f.target, "child"), 1234567890, 1234567890);
  await assert.rejects(
    f.trash.capture(f.globalScope, f.target, { jobId: f.jobId, reason: "deleted" }),
    { code: "FILE_CONFLICT_CHANGED" },
  );
  assert.equal((await f.trash.list(f.globalScope)).entries[0].availability, "pending");
});
