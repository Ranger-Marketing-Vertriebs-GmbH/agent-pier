import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { copyFixture, submitCopy } from "../helpers/file-copy.js";
import { applicationFixture } from "../helpers/application.js";
import { waitForFileJob } from "../helpers/file-explorer.js";
import { recoverPublications } from "../../server/features/files/file-recovery.js";
import { entryRevision, resolveFile } from "../../server/features/files/file-paths.js";
import { inodeIdentity } from "../../server/features/files/file-stage.js";

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

test("merge-root removal checkpoint failure retains truthful output and repairs once after restart", async (t) => {
  const f = await applicationFixture(t),
    source = path.join(f.home, "source"),
    target = path.join(f.home, "target");
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.mkdir(path.join(target, "source"));
  await fs.writeFile(path.join(source, "child"), "moved bytes");
  const files = f.application.files,
    checkpoint = files.store.checkpointTransferEntry.bind(files.store);
  let interrupted = false,
    heldPath = false,
    heldBarrier = false;
  files.store.checkpointTransferEntry = (jobId, row, ...args) => {
    if (row.source === source && row.sourceRemoved && !interrupted) {
      interrupted = true;
      heldPath = files.locks.hasLease();
      heldBarrier = files.publisher.barrier.hasLease();
      throw Error("injected merge completion checkpoint");
    }
    return checkpoint(jobId, row, ...args);
  };
  const requestId = `${Date.now()}:${crypto.randomUUID()}`;
  const job = await submitCopy(f, [source], target, { kind: "move", requestId });
  const conflict = await waitForFileJob(f, job.id, { states: ["waiting_for_conflict"] });
  await files.jobs.resolve(await files.context(), job.id, {
    conflictId: conflict.conflict.id,
    decision: "merge",
    applyToRemaining: false,
  });
  const done = await waitForFileJob(f, job.id);
  assert.equal(interrupted, true);
  assert.equal(done.status, "partially_completed");
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
  const entries = async () =>
    (await (await f.request(`/api/files/jobs/${job.id}/entries`)).json()).entries;
  let root = (await entries()).find((row) => row.source === source);
  assert.equal(root.status, "published");
  assert.equal(root.outputPublished, true);
  assert.equal(root.sourceRemoved, false);
  assert.equal(root.sourceRemovalPending, true);
  assert.equal(done.completedEntries, 1);
  assert.equal(heldPath, true);
  assert.equal(heldBarrier, true);
  const unresolved = files.store
    .listPublications()
    .find((record) => record.jobId === job.id && record.document.mergeRemoval);
  assert.ok(unresolved);
  assert.notEqual(unresolved.phase, "resolved");
  await f.restart();
  root = (await entries()).find((row) => row.source === source);
  assert.equal(root.status, "completed");
  assert.equal(root.sourceRemoved, true);
  assert.equal(root.sourceRemovalPending, false);
  assert.equal((await waitForFileJob(f, job.id)).completedEntries, 2);
  assert.equal((await waitForFileJob(f, job.id)).completedBytes, 11);
  assert.equal(
    await fs.readFile(path.join(target, "source", "child"), "utf8"),
    "moved bytes",
  );
  assert.equal(
    (await submitCopy(f, [source], target, { kind: "move", requestId })).id,
    job.id,
  );
  await f.restart();
  assert.equal((await waitForFileJob(f, job.id)).completedEntries, 2);
  assert.equal((await entries()).length, 2);
});

test("nested merge retains a pending child's source parent for read-only reconciliation", async (t) => {
  const f = await copyFixture(t),
    source = path.join(f.home, "source"),
    child = path.join(source, "sub"),
    target = path.join(f.project, "source", "sub");
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(child, "file"), "keep");
  const originalParent = (await fs.stat(source)).ino,
    checkpoint = f.store.checkpointTransferEntry.bind(f.store);
  let interrupted = false;
  f.store.checkpointTransferEntry = (jobId, row, ...args) => {
    if (row.source === child && row.sourceRemoved && !interrupted) {
      interrupted = true;
      throw Error("injected nested completion");
    }
    return checkpoint(jobId, row, ...args);
  };
  const job = await f.start(f.operation([source], f.project, "move"));
  await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "merge", true);
  assert.equal((await f.wait(job.id)).status, "partially_completed");
  const rows = () => f.jobs.entries(f.globalScope, job.id).entries,
    row = (name) => rows().find((entry) => entry.source === name);
  assert.equal(interrupted, true);
  await assert.rejects(fs.lstat(child), { code: "ENOENT" });
  assert.equal((await fs.stat(source)).ino, originalParent);
  assert.equal(row(child).sourceRemovalPending, true);
  assert.equal(row(source).sourceRemovalPending, false);
  assert.equal(row(source).sourceRemoved, false);
  assert.equal(row(source).outputPublished, true);
  assert.equal((await f.wait(job.id)).completedEntries, 1);
  const nativeRun = f.native.run.bind(f.native);
  f.native.run = (op, args) => {
    assert.notEqual(op, "removeEntry", "reconciliation never retries removal");
    return nativeRun(op, args);
  };
  await recoverPublications(f);
  assert.equal(row(child).sourceRemoved, true);
  assert.equal(row(child).sourceRemovalPending, false);
  assert.equal((await f.wait(job.id)).completedEntries, 2);
  assert.equal((await fs.stat(source)).ino, originalParent);
  assert.deepEqual(await fs.readdir(source), []);
  assert.equal(row(source).sourceRemoved, false);
  await recoverPublications(f);
  assert.equal((await f.wait(job.id)).completedEntries, 2);
  assert.equal(await fs.readFile(path.join(target, "file"), "utf8"), "keep");
});

test("merge completion row, counters and journal marker roll back together", async (t) => {
  const f = await copyFixture(t),
    source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.mkdir(path.join(f.project, "source"));
  const put = f.store.putPublication.bind(f.store);
  let interrupted = false;
  f.store.putPublication = (record) => {
    if (record.document.mergeRemoval && record.phase === "resolved" && !interrupted) {
      interrupted = true;
      throw Error("injected final journal write");
    }
    return put(record);
  };
  const job = await f.start(f.operation([source], f.project, "move"));
  await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "merge");
  assert.equal((await f.wait(job.id)).status, "partially_completed");
  assert.equal(interrupted, true);
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
  const row = () => f.jobs.entries(f.globalScope, job.id).entries[0],
    record = () => f.store.listPublications().find((item) => item.jobId === job.id);
  assert.equal(row().sourceRemovalPending, true);
  assert.equal(row().sourceRemoved, false);
  assert.equal((await f.wait(job.id)).completedEntries, 0);
  assert.equal(record().document.mergeRemoval.disposition, "pending");
  assert.notEqual(record().phase, "resolved");
  await recoverPublications(f);
  assert.equal(row().sourceRemoved, true);
  assert.equal(row().sourceRemovalPending, false);
  assert.equal(record().document.mergeRemoval.disposition, "removed");
  assert.equal(record().phase, "resolved");
  assert.equal((await f.wait(job.id)).completedEntries, 1);
  await recoverPublications(f);
  assert.equal((await f.wait(job.id)).completedEntries, 1);
});

for (const changed of ["source", "source parent", "destination", "destination parent"]) {
  test(`merge removal recovery preserves pending evidence for a replaced ${changed}`, async (t) => {
    const f = await copyFixture(t),
      parent = path.join(f.home, "parent"),
      source = path.join(parent, "source"),
      target = path.join(f.project, "source");
    await fs.mkdir(source, { recursive: true });
    await fs.mkdir(target);
    const checkpoint = f.store.checkpointTransferEntry.bind(f.store);
    let interrupted = false;
    f.store.checkpointTransferEntry = (jobId, row, ...args) => {
      if (row.sourceRemoved && !interrupted) {
        interrupted = true;
        throw Error("injected merge completion");
      }
      return checkpoint(jobId, row, ...args);
    };
    const job = await f.start(f.operation([source], f.project, "move"));
    await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "merge");
    await f.wait(job.id);
    const replaced =
      changed === "source"
        ? source
        : changed === "source parent"
          ? parent
          : changed === "destination"
            ? target
            : f.project;
    if (changed !== "source") await fs.rename(replaced, `${replaced}-retained`);
    await fs.mkdir(replaced);
    await fs.writeFile(path.join(replaced, "external"), "must retain");
    const nativeRun = f.native.run.bind(f.native);
    f.native.run = (op, args) => {
      assert.notEqual(op, "removeEntry", "uncertain recovery never deletes by name");
      return nativeRun(op, args);
    };
    const outcome = await recoverPublications(f);
    assert.equal(outcome[0].phase, "interrupted");
    const row = () => f.jobs.entries(f.globalScope, job.id).entries[0];
    assert.equal(row().sourceRemoved, false);
    assert.equal(row().sourceRemovalPending, true);
    assert.equal(row().outputPublished, true);
    assert.equal((await f.wait(job.id)).completedEntries, 0);
    assert.equal(
      await fs.readFile(path.join(replaced, "external"), "utf8"),
      "must retain",
    );
    await fs.rename(replaced, `${replaced}-external`);
    if (changed !== "source") await fs.rename(`${replaced}-retained`, replaced);
    assert.equal((await recoverPublications(f))[0].phase, "resolved");
    assert.equal(row().sourceRemoved, true);
    assert.equal(row().sourceRemovalPending, false);
    assert.equal((await f.wait(job.id)).completedEntries, 1);
  });
}

test("merge removal intent with retained source reconciles without repeating the syscall", async (t) => {
  const f = await copyFixture(t, (op, args, run) => {
    if (op === "removeEntry" && args.name === "source")
      throw Error("injected pre-syscall interruption");
    return run(op, args);
  });
  const source = path.join(f.home, "source");
  await fs.mkdir(source);
  await fs.mkdir(path.join(f.project, "source"));
  const identity = (await fs.stat(source)).ino;
  const job = await f.start(f.operation([source], f.project, "move"));
  await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "merge");
  assert.equal((await f.wait(job.id)).status, "partially_completed");
  const row = () => f.jobs.entries(f.globalScope, job.id).entries[0];
  assert.equal(row().sourceRemovalPending, true);
  await recoverPublications(f);
  assert.equal((await fs.stat(source)).ino, identity);
  assert.equal(row().sourceRemovalPending, false);
  assert.equal(row().sourceRemoved, false);
  assert.equal(row().outputPublished, true);
  assert.equal(row().status, "published");
  assert.equal((await f.wait(job.id)).completedEntries, 0);
  assert.equal(
    f.store.listPublications()[0].document.mergeRemoval.disposition,
    "retained",
  );
});

for (const edited of ["source", "target"]) {
  test(`merge removal recovery rejects a retained ${edited} with the same inode and changed recorded revision`, async (t) => {
    const f = await copyFixture(t, (op, args, run) => {
      if (edited === "source" && op === "removeEntry" && args.name === "source")
        throw Error("injected pre-syscall interruption");
      return run(op, args);
    });
    const source = path.join(f.home, "source"),
      target = path.join(f.project, "source");
    await fs.mkdir(source);
    await fs.mkdir(target);
    if (edited === "target") {
      const checkpoint = f.store.checkpointTransferEntry.bind(f.store);
      let interrupted = false;
      f.store.checkpointTransferEntry = (jobId, row, ...args) => {
        if (row.sourceRemoved && !interrupted) {
          interrupted = true;
          throw Error("injected post-syscall checkpoint failure");
        }
        return checkpoint(jobId, row, ...args);
      };
    }
    const job = await f.start(f.operation([source], f.project, "move"));
    await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "merge");
    assert.equal((await f.wait(job.id)).status, "partially_completed");
    if (edited === "target") await assert.rejects(fs.lstat(source), { code: "ENOENT" });
    const publication = () =>
        f.store.listPublications().find((row) => row.jobId === job.id),
      proof = publication().document.mergeRemoval,
      editedPath = edited === "source" ? source : target,
      identity =
        edited === "source" ? proof.identity : publication().document.targetIdentity,
      revision = edited === "source" ? proof.sourceRevision : proof.targetRevision;
    const before = await resolveFile(f.globalScope, editedPath, { followLeaf: false });
    assert.equal(inodeIdentity(before.stat), identity);
    assert.equal(entryRevision(before.stat, before.linkIdentity), revision);
    await fs.writeFile(path.join(editedPath, "external"), "must retain");
    await fs.utimes(editedPath, new Date("2030-01-01Z"), new Date("2030-01-01Z"));
    const changed = await resolveFile(f.globalScope, editedPath, { followLeaf: false });
    assert.equal(inodeIdentity(changed.stat), identity);
    assert.notEqual(entryRevision(changed.stat, changed.linkIdentity), revision);
    const nativeRun = f.native.run.bind(f.native);
    f.native.run = (op, args) => {
      assert.notEqual(op, "removeEntry", "recovery cannot retry source removal");
      return nativeRun(op, args);
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      assert.equal((await recoverPublications(f))[0].phase, "interrupted");
      const row = f.jobs.entries(f.globalScope, job.id).entries[0];
      assert.equal(row.sourceRemovalPending, true);
      assert.equal(row.sourceRemoved, false);
      assert.equal(row.outputPublished, true);
      assert.equal((await f.wait(job.id)).completedEntries, 0);
      assert.equal(publication().document.mergeRemoval.disposition, "pending");
      assert.equal(
        publication().document.mergeRemoval.sourceRevision,
        proof.sourceRevision,
      );
      assert.equal(
        await fs.readFile(path.join(editedPath, "external"), "utf8"),
        "must retain",
      );
      assert.equal(
        inodeIdentity((await resolveFile(f.globalScope, target)).stat),
        publication().document.targetIdentity,
      );
    }
  });
}
