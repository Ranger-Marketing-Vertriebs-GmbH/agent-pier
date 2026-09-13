import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { copyFixture } from "../helpers/file-copy.js";
import { recoverPublications } from "../../server/features/files/file-recovery.js";

test("cross-folder same-filesystem moves retain inode and durably deduplicate request IDs", async (t) => {
  const f = await copyFixture(t);
  const source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "child"), "keep");
  const before = await fs.stat(source);
  const operation = f.operation([source], f.project, "move");
  const job = await f.start(operation),
    done = await f.wait(job.id);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal((await fs.stat(path.join(f.project, "source"))).ino, before.ino);
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
  assert.equal(done.completedEntries, 2);
  assert.equal((await f.start(operation)).id, job.id);
  assert.equal(f.jobs.entries(f.globalScope, job.id).entries.length, 2);
});

test("EXDEV strict metadata refusal retains source and leaves target absent", async (t) => {
  let attempted = false;
  const f = await copyFixture(t, (op, args, run) => {
    if (op === "renameNoReplace" && args.oldName === "source") {
      attempted = true;
      throw Object.assign(Error(), { code: "EXDEV" });
    }
    if (op === "copyMetadata") {
      assert.equal(args.strictOwnership, true);
      throw Object.assign(Error(), { code: "ENOTSUP" });
    }
    return run(op, args);
  });
  const source = path.join(f.home, "source");
  await fs.writeFile(source, "keep");
  const job = await f.start(f.operation([source], f.project, "move"));
  const done = await f.wait(job.id);
  assert.equal(attempted, true);
  assert.equal(done.status, "failed");
  assert.equal(done.issue.code, "FILE_METADATA_UNSUPPORTED");
  assert.equal(await fs.readFile(source, "utf8"), "keep");
  await assert.rejects(fs.lstat(path.join(f.project, "source")), { code: "ENOENT" });
});

test("EXDEV streams verified bytes then removes source only after publication", async (t) => {
  const f = await copyFixture(t, async (op, args, run, f) => {
    if (op === "renameNoReplace" && args.oldName === "source")
      throw Object.assign(Error(), { code: "EXDEV" });
    if (op === "removeEntry" && args.name === "source")
      assert.equal(await fs.readFile(path.join(f.project, "source"), "utf8"), "keep");
    return run(op, args);
  });
  const source = path.join(f.home, "source");
  await fs.writeFile(source, "keep");
  const before = await fs.stat(source),
    job = await f.start(f.operation([source], f.project, "move"));
  const done = await f.wait(job.id);
  if (process.platform === "linux") {
    assert.equal(done.issue.code, "FILE_METADATA_UNSUPPORTED");
    assert.equal(await fs.readFile(source, "utf8"), "keep");
    return;
  }
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.completedEntries, 1);
  assert.equal(done.completedBytes, 4);
  assert.notEqual((await fs.stat(path.join(f.project, "source"))).ino, before.ino);
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
});

test("source changes after EXDEV publication retain output and unfinished source separately", async (t) => {
  const f = await copyFixture(t, async (op, args, run, f) => {
    if (op === "renameNoReplace" && args.oldName === "source")
      throw Object.assign(Error(), { code: "EXDEV" });
    const result = await run(op, args);
    if (op === "renameNoReplace" && args.newName === "source")
      await fs.writeFile(path.join(f.home, "source"), "changed source");
    return result;
  });
  const source = path.join(f.home, "source");
  await fs.writeFile(source, "original");
  const job = await f.start(f.operation([source], f.project, "move")),
    done = await f.wait(job.id);
  if (process.platform === "linux") {
    assert.equal(done.issue.code, "FILE_METADATA_UNSUPPORTED");
    return;
  }
  assert.equal(done.status, "partially_completed", JSON.stringify(done));
  assert.equal(done.completedEntries, 0);
  assert.equal(await fs.readFile(source, "utf8"), "changed source");
  assert.equal(await fs.readFile(path.join(f.project, "source"), "utf8"), "original");
  const row = f.jobs.entries(f.globalScope, job.id).entries[0];
  assert.equal(row.status, "published");
  assert.equal(row.sourceRemoved, false);
  assert.equal(row.source, source);
  assert.equal(row.outputPublished, true);
});

test("cross-folder failed publication restores source and cleans target-parent stage", async (t) => {
  const f = await copyFixture(t, (op, args, run) => {
    if (op === "exchange") throw Object.assign(Error(), { code: "EACCES" });
    return run(op, args);
  });
  const source = path.join(f.home, "source");
  await fs.writeFile(source, "source");
  await fs.writeFile(path.join(f.project, "source"), "target");
  const job = await f.start(f.operation([source], f.project, "move"));
  await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "replace");
  assert.equal((await f.wait(job.id)).status, "failed");
  assert.equal(await fs.readFile(source, "utf8"), "source");
  assert.equal(await fs.readFile(path.join(f.project, "source"), "utf8"), "target");
  assert.deepEqual(await fs.readdir(f.project), ["source"]);
});

test("startup records a move completed between publication syscall and checkpoint exactly once", async (t) => {
  const f = await copyFixture(t),
    source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "child"), "keep");
  const put = f.store.putPublication.bind(f.store);
  let interrupted = false;
  f.store.putPublication = (record) => {
    if (record.phase === "exchanged" && !interrupted) {
      interrupted = true;
      throw Error("injected durable boundary");
    }
    return put(record);
  };
  const operation = f.operation([source], f.project, "move"),
    job = await f.start(operation);
  assert.equal((await f.wait(job.id)).completedEntries, 0);
  assert.equal(
    await fs.readFile(path.join(f.project, "source", "child"), "utf8"),
    "keep",
  );
  await recoverPublications(f);
  assert.equal(f.jobs.get(f.globalScope, job.id).completedEntries, 2);
  assert.equal(f.jobs.get(f.globalScope, job.id).completedBytes, 4);
  const rows = f.jobs.entries(f.globalScope, job.id).entries;
  assert.equal(
    rows.filter((row) => row.status === "completed" && row.sourceRemoved).length,
    2,
  );
  await recoverPublications(f);
  assert.equal(f.jobs.get(f.globalScope, job.id).completedEntries, 2);
  assert.equal((await f.start(operation)).id, job.id);
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
  assert.deepEqual(await fs.readdir(f.project), ["source"]);
});

test("completion marker survives container removal before resolved journal write", async (t) => {
  const f = await copyFixture(t),
    source = path.join(f.home, "source");
  await fs.writeFile(source, "keep");
  const put = f.store.putPublication.bind(f.store);
  let interrupted = false;
  f.store.putPublication = (record) => {
    if (
      record.phase === "resolved" &&
      record.document.transferCompleted &&
      !interrupted
    ) {
      interrupted = true;
      throw Error("injected final journal");
    }
    return put(record);
  };
  const job = await f.start(f.operation([source], f.project, "move"));
  await f.wait(job.id);
  assert.equal(f.jobs.get(f.globalScope, job.id).completedEntries, 1);
  await recoverPublications(f);
  assert.equal(
    f.store
      .listPublications()
      .filter((record) => record.jobId === job.id)
      .every((record) => record.phase === "resolved"),
    true,
  );
  assert.equal(f.jobs.get(f.globalScope, job.id).completedEntries, 1);
});

test("same-filesystem move rejects a descendant edited while directory conflict waits", async (t) => {
  const f = await copyFixture(t),
    source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "child"), "before");
  await fs.mkdir(path.join(f.project, "source"));
  const job = await f.start(f.operation([source], f.project, "move"));
  const conflict = await f.wait(job.id, ["waiting_for_conflict"]);
  await fs.writeFile(path.join(source, "child"), "after!");
  await assert.rejects(f.resolve(conflict, "keep_both"), {
    code: "FILE_CONFLICT_CHANGED",
  });
  assert.equal(await fs.readFile(path.join(source, "child"), "utf8"), "after!");
  await assert.rejects(fs.lstat(path.join(f.project, "source (2)")), { code: "ENOENT" });
});

test("nested directory merges complete all child moves and remove only empty source directories", async (t) => {
  const f = await copyFixture(t),
    source = path.join(f.home, "source"),
    target = path.join(f.project, "source");
  await fs.mkdir(path.join(source, "sub"), { recursive: true });
  await fs.mkdir(path.join(target, "sub"), { recursive: true });
  await fs.writeFile(path.join(source, "sub", "child"), "source");
  await fs.writeFile(path.join(target, "sub", "existing"), "keep");
  const job = await f.start(f.operation([source], f.project, "move"));
  await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "merge", true);
  const done = await f.wait(job.id);
  assert.equal(done.status, "completed", JSON.stringify(done));
  assert.equal(done.completedEntries, 3);
  assert.equal(done.completedBytes, 6);
  assert.equal(await fs.readFile(path.join(target, "sub", "child"), "utf8"), "source");
  assert.equal(await fs.readFile(path.join(target, "sub", "existing"), "utf8"), "keep");
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
});

test("failed completion transaction never persists a marker for rolled-back rows", async (t) => {
  const f = await copyFixture(t),
    source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.writeFile(path.join(source, "child"), "keep");
  const put = f.store.putEntry.bind(f.store);
  let interrupted = false;
  f.store.putEntry = (jobId, row) => {
    if (row.relativePath === "child" && row.status === "completed" && !interrupted) {
      interrupted = true;
      throw Error("injected completion transaction");
    }
    return put(jobId, row);
  };
  const job = await f.start(f.operation([source], f.project, "move"));
  await f.wait(job.id);
  assert.equal(f.jobs.get(f.globalScope, job.id).completedEntries, 0);
  assert.equal(
    f.store.listPublications().find((record) => record.jobId === job.id).document
      .transferCompleted,
    undefined,
  );
  await recoverPublications(f);
  assert.equal(f.jobs.get(f.globalScope, job.id).completedEntries, 2);
  assert.equal(
    f.jobs
      .entries(f.globalScope, job.id)
      .entries.filter((row) => row.status === "completed").length,
    2,
  );
});
