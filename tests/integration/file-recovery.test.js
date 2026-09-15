import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { recoverPublications } from "../../server/features/files/file-recovery.js";
import { fixture } from "../helpers/file-publisher.js";
import { copyFixture } from "../helpers/file-copy.js";

async function bounded(promise, label, timeout = 5000) {
  return Promise.race([
    promise,
    delay(timeout, null, { ref: false }).then(() => {
      throw new Error(`${label} did not settle in ${timeout}ms`);
    }),
  ]);
}

test("merge removal recovery retains an intent without historical target content proof", async (t) => {
  const f = await copyFixture(t),
    source = path.join(f.home, "source"),
    target = path.join(f.project, "source");
  await fs.mkdir(source);
  await fs.mkdir(target);
  const checkpoint = f.store.checkpointTransferEntry.bind(f.store);
  let interrupted = false;
  f.store.checkpointTransferEntry = (jobId, row, ...args) => {
    if (row.sourceRemoved && !interrupted) {
      interrupted = true;
      throw Error("injected post-syscall checkpoint failure");
    }
    return checkpoint(jobId, row, ...args);
  };
  const job = await f.start(f.operation([source], f.project, "move"));
  await f.resolve(await f.wait(job.id, ["waiting_for_conflict"]), "merge");
  assert.equal((await f.wait(job.id)).status, "partially_completed");
  await assert.rejects(fs.lstat(source), { code: "ENOENT" });
  const record = f.store.listPublications().find((row) => row.jobId === job.id);
  delete record.document.mergeRemoval.targetContent;
  f.store.putPublication(record);
  const targetInode = (await fs.stat(target)).ino,
    nativeRun = f.native.run.bind(f.native);
  f.native.run = (op, args) => {
    assert.notEqual(op, "removeEntry", "missing proof never permits a removal retry");
    return nativeRun(op, args);
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.equal((await recoverPublications(f))[0].phase, "interrupted");
    const row = f.jobs.entries(f.globalScope, job.id).entries[0];
    assert.equal(row.sourceRemovalPending, true);
    assert.equal(row.sourceRemoved, false);
    assert.equal(row.outputPublished, true);
    assert.equal((await f.wait(job.id)).completedEntries, 0);
    assert.equal((await fs.stat(target)).ino, targetInode);
  }
});

for (const unrelated of [false, true])
  test(`recovery replays twice without changing bytes (unrelated ${unrelated})`, async (t) => {
    const f = await fixture(t, async (op, args, run) => {
      const result = await run(op, args);
      if (op === "exchange") throw Error("crash after exchange");
      return result;
    });
    await fs.writeFile(f.target, "original");
    const revision = await f.revision();
    const stage = await f.stage();
    await stage.handle.writeFile("replacement");
    await assert.rejects(
      f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
    );
    if (unrelated) {
      await fs.rename(f.target, `${f.target}.published`);
      await fs.writeFile(f.target, "unrelated");
    }
    for (let i = 0; i < 2; i++) {
      const outcomes = await recoverPublications({
        store: f.store,
        native: f.native,
        barrier: f.barrier,
      });
      assert.equal(outcomes[0].id, stage.id);
      assert.equal(
        f.store.getPublication(stage.id).phase,
        unrelated ? "interrupted" : "swapped",
      );
      if (unrelated) assert.equal(outcomes[0].issue.code, "FILE_INTERRUPTED");
      assert.equal(await fs.readFile(stage.file, "utf8"), "original");
      assert.equal(
        await fs.readFile(unrelated ? `${f.target}.published` : f.target, "utf8"),
        "replacement",
      );
      if (unrelated) assert.equal(await fs.readFile(f.target, "utf8"), "unrelated");
    }
  });

test("recovery refuses a replaced stage parent and never cleans similarly named entries", async (t) => {
  const f = await fixture(t);
  const stage = await f.stage();
  await stage.handle.writeFile("registered");
  await f.publisher.close();
  const directory = stage.file.slice(0, stage.file.lastIndexOf("/"));
  await fs.rename(directory, `${directory}.retained`);
  await fs.mkdir(directory);
  await fs.writeFile(stage.file, "unrelated");
  const outcomes = await recoverPublications({ store: f.store, native: f.native });
  assert.equal(outcomes[0].issue.code, "FILE_INTERRUPTED");
  assert.equal(await fs.readFile(stage.file, "utf8"), "unrelated");
  assert.equal(await fs.readFile(`${directory}.retained/content`, "utf8"), "registered");
});

test("recovery does not call a post-exchange external edit a completed publication", async (t) => {
  const f = await fixture(t, async (op, args, run, f) => {
    const result = await run(op, args);
    if (op === "exchange") {
      await fs.writeFile(f.target, "external");
      throw Error("crash");
    }
    return result;
  });
  await fs.writeFile(f.target, "original");
  const revision = await f.revision(),
    stage = await f.stage();
  await stage.handle.writeFile("replacement");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
  );
  const [result] = await recoverPublications({ store: f.store, native: f.native });
  assert.equal(result.phase, "interrupted");
  assert.equal(result.issue.code, "FILE_INTERRUPTED");
  assert.equal(await fs.readFile(stage.file, "utf8"), "original");
  assert.equal(await fs.readFile(f.target, "utf8"), "external");
});

test("crash replay revalidates a followed selected link before claiming recovery", async (t) => {
  const f = await fixture(t),
    link = `${f.target}.link`,
    outside = `${f.target}.outside`;
  await fs.writeFile(f.target, "original");
  await fs.writeFile(outside, "sentinel");
  await fs.symlink(f.target, link);
  const { resolveFile } = await import("../../server/features/files/file-paths.js");
  const { fileRevision } = await import("../../server/features/files/file-publish.js");
  const selected = await resolveFile(f.globalScope, link, { followLeaf: true });
  const source = await fs.open(f.target, "r");
  const revision = await fileRevision(source, selected.linkIdentity);
  await source.close();
  const stage = await f.publisher.stage(f.globalScope, link, {
    jobId: f.jobId,
    followLeaf: true,
  });
  await stage.handle.writeFile("replacement");
  const run = f.native.run.bind(f.native);
  f.native.run = async (op, args) => {
    const result = await run(op, args);
    if (op === "exchange") {
      await fs.unlink(link);
      await fs.symlink(outside, link);
      throw Error("crash");
    }
    return result;
  };
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
  );
  const [outcome] = await recoverPublications({ store: f.store, native: f.native });
  assert.equal(outcome.phase, "interrupted");
  assert.equal(await fs.readFile(outside, "utf8"), "sentinel");
  assert.equal(await fs.readFile(f.target, "utf8"), "replacement");
  assert.equal(await fs.readFile(stage.file, "utf8"), "original");
});

test("two replays of a failure before exchange retain original and staged bytes", async (t) => {
  const f = await fixture(t, (op, args, run) => {
    if (op === "exchange") throw Error("before exchange");
    return run(op, args);
  });
  await fs.writeFile(f.target, "original");
  const revision = await f.revision(),
    stage = await f.stage();
  await stage.handle.writeFile("replacement");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
  );
  for (let replay = 0; replay < 2; replay++) {
    const [outcome] = await recoverPublications({ store: f.store, native: f.native });
    assert.equal(outcome.phase, "interrupted");
    assert.equal(await fs.readFile(f.target, "utf8"), "original");
    assert.equal(await fs.readFile(stage.file, "utf8"), "replacement");
  }
});

test("recovery hashes outside the barrier and commits durability plus journal under one lease", async (t) => {
  const f = await fixture(t, async (op, args, run) => {
    const result = await run(op, args);
    if (op === "exchange") throw Error("crash after exchange");
    return result;
  });
  await fs.writeFile(f.target, "original");
  const revision = await f.revision(),
    stage = await f.stage();
  await stage.handle.writeFile("replacement");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: revision }),
  );
  const run = f.native.run.bind(f.native);
  let enterRead,
    releaseRead,
    gated = false;
  const reading = new Promise((resolve) => {
    enterRead = resolve;
  });
  const released = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const durability = [],
    journal = [];
  f.native.run = async (op, args) => {
    if (op === "read" && !gated) {
      gated = true;
      enterRead();
      await released;
    }
    if (["sync", "removeEntry"].includes(op)) durability.push(f.barrier.hasLease());
    return run(op, args);
  };
  const put = f.store.putPublication.bind(f.store);
  f.store.putPublication = (record) => {
    journal.push(f.barrier.hasLease());
    return put(record);
  };
  let recovery, outcome;
  let snapshotRan = false;
  try {
    recovery = recoverPublications({
      store: f.store,
      native: f.native,
      barrier: f.barrier,
    });
    const prematureRecovery = recovery.then(
      () => {
        throw new Error("recovery settled before its read gate was released");
      },
      (error) => {
        throw error;
      },
    );
    await bounded(Promise.race([reading, prematureRecovery]), "recovery read gate");
    await bounded(
      Promise.race([
        f.barrier.snapshot(() => {
          snapshotRan = true;
        }),
        prematureRecovery,
      ]),
      "concurrent application snapshot",
    );
  } finally {
    releaseRead?.();
    if (recovery) [outcome] = await bounded(recovery, "released recovery");
  }
  assert.equal(snapshotRan, true);
  assert.equal(outcome.phase, "swapped");
  assert.ok(durability.length >= 2);
  assert.ok(durability.every(Boolean));
  assert.ok(journal.length > 0 && journal.every(Boolean));
});

test("an application snapshot cannot observe recovery cleanup before its journal transition", async (t) => {
  const f = await fixture(t, async (op, args, run) => {
    const result = await run(op, args);
    if (op === "renameNoReplace") throw Error("crash after publication");
    return result;
  });
  const stage = await f.stage();
  await stage.handle.writeFile("published");
  await assert.rejects(
    f.publisher.publish(f.globalScope, stage, { expectedRevision: null }),
  );
  const run = f.native.run.bind(f.native);
  let snapshot, observedPhase;
  f.native.run = async (op, args) => {
    const result = await run(op, args);
    if (op === "removeEntry")
      snapshot = f.barrier.detached(() =>
        f.barrier.snapshot(() => {
          observedPhase = f.store.getPublication(stage.id).phase;
        }),
      );
    return result;
  };
  const [outcome] = await recoverPublications({
    store: f.store,
    native: f.native,
    barrier: f.barrier,
  });
  await snapshot;
  assert.equal(outcome.phase, "resolved");
  assert.equal(observedPhase, "resolved");
  assert.equal(await fs.readFile(f.target, "utf8"), "published");
  assert.equal(f.barrier.active, 0);
});
