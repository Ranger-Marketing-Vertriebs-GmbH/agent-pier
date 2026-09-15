import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { Writable } from "node:stream";
import { uploadFixture } from "../helpers/file-uploads.js";
import { archiveOperation, artifactBytes, zipEntries } from "../helpers/file-archives.js";
import { makeFileScope } from "../../server/features/files/file-scope.js";

async function archive(f, extra = {}) {
  const source = path.join(f.home, "source");
  await fs.writeFile(source, "original source");
  const operation = archiveOperation([source], extra);
  const job = await f.jobs.start(f.scope, operation);
  return { operation, job, result: await f.jobs.join(f.scope, job.id) };
}

test("read-only selected project root permits archive and omission consent, never output-file", async (t) => {
  const f = await uploadFixture(t);
  f.scope = await makeFileScope({
    home: f.home,
    session: { id: "fixture", cwd: f.project, pipeline: { headless: true } },
  });
  f.jobs.context = async () => f.scope;
  await fs.writeFile(path.join(f.project, "file"), "read only");
  await fs.symlink("file", path.join(f.project, "link"));
  await assert.rejects(
    f.jobs.start(
      f.scope,
      archiveOperation(["."], {
        target: ".",
        name: "out.zip",
        options: { output: "file" },
      }),
    ),
    { code: "FILE_READ_ONLY" },
  );
  const job = await f.jobs.start(f.scope, archiveOperation(["."]));
  const conflict = await f.until(() => f.jobs.get(f.scope, job.id).conflict);
  await f.jobs.resolve(f.scope, job.id, {
    conflictId: conflict.id,
    decision: "skip_links",
    applyToRemaining: false,
  });
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
  assert.equal(
    (await zipEntries(await artifactBytes(f, job.id))).get("project/file").toString(),
    "read only",
  );
  assert.deepEqual((await fs.readdir(f.project)).sort(), ["file", "link"]);
});

test("artifact queued/active claims share three slots and prevent retention until drainage", async (t) => {
  const f = await uploadFixture(t),
    { job } = await archive(f);
  const record = f.store.getPublication(f.store.archives.get(job.id).publicationId),
    name = record.document.staged;
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  let count = 0;
  const owners = Array.from({ length: 3 }, () =>
    f.jobs.runDirectTransfer(f.scope, async () => {
      if (++count === 3) entered.resolve();
      await gate.promise;
    }),
  );
  await entered.promise;
  let artifactOpens = 0;
  const run = f.publisher.native.run.bind(f.publisher.native);
  f.publisher.native.run = (op, args) => {
    if (op === "openFile") artifactOpens++;
    return run(op, args);
  };
  const controller = new AbortController(),
    out = new Writable({
      write(c, e, cb) {
        cb();
      },
    });
  out.setHeader = () => {};
  const queued = f.archives.downloadJobArtifact(f.scope, job.id, out, {
    signal: controller.signal,
  });
  const rejected = assert.rejects(queued);
  try {
    await f.until(() => f.archives.claims.get(job.id) === 1);
    assert.equal(artifactOpens, 0);
    assert.equal(f.jobs.transfers, 3);
    await f.archives.sweep(Date.now() + 8 * 86400000);
    await fs.access(name);
    controller.abort();
    await rejected;
    assert.equal(f.archives.claims.size, 0);
  } finally {
    controller.abort();
    gate.resolve();
    await Promise.allSettled(owners);
  }
  const begun = Promise.withResolvers();
  let callback;
  const slow = new Writable({
    highWaterMark: 1,
    write(chunk, encoding, cb) {
      callback = cb;
      begun.resolve();
    },
  });
  slow.setHeader = () => {};
  const active = f.archives.downloadJobArtifact(f.scope, job.id, slow);
  try {
    await begun.promise;
    assert.equal(f.archives.claims.get(job.id), 1);
    await f.archives.sweep(Date.now() + 8 * 86400000);
    await fs.access(name);
  } finally {
    callback?.();
    await active;
  }
  await f.archives.sweep(Date.now() + 8 * 86400000);
  await assert.rejects(fs.access(name), { code: "ENOENT" });
  f.store.prune(Date.now() + 8 * 86400000);
  assert.throws(() => f.jobs.get(f.scope, job.id), { code: "FILE_NOT_FOUND" });
});

test("tampered artifact stays unavailable/pinned while published user ZIP survives retention", async (t) => {
  const f = await uploadFixture(t),
    download = await archive(f);
  const record = f.store.getPublication(
    f.store.archives.get(download.job.id).publicationId,
  );
  await fs.appendFile(record.document.staged, "tamper");
  await assert.rejects(artifactBytes(f, download.job.id), {
    code: "FILE_CONFLICT_CHANGED",
  });
  await f.archives.sweep(Date.now() + 8 * 86400000);
  f.store.prune(Date.now() + 8 * 86400000);
  await fs.access(record.document.staged);
  const published = await archive(f, {
    target: f.home,
    name: "public.zip",
    options: { output: "file" },
  });
  assert.equal(published.result.status, "completed", JSON.stringify(published.result));
  const target = path.join(f.home, "public.zip"),
    before = await fs.stat(target),
    bytes = await fs.readFile(target);
  await f.archives.sweep(Date.now() + 8 * 86400000);
  f.store.prune(Date.now() + 8 * 86400000);
  assert.equal((await fs.stat(target)).ino, before.ino);
  assert.deepEqual(await fs.readFile(target), bytes);
});

for (const phase of ["complete", "cleanup"])
  test(`public archive restart recovers ${phase} checkpoint without rebuilding`, async (t) => {
    const f = await uploadFixture(t),
      target = path.join(f.home, "archive.zip");
    let injected = false;
    if (phase === "complete") {
      const complete = f.store.archives.complete.bind(f.store.archives);
      f.store.archives.complete = (...args) => {
        if (!injected) {
          injected = true;
          throw new Error("checkpoint failure");
        }
        return complete(...args);
      };
    } else {
      const run = f.publisher.native.run.bind(f.publisher.native);
      f.publisher.native.run = (op, args) => {
        if (!injected && op === "removeEntry" && args.type === "directory") {
          injected = true;
          throw new Error("cleanup failure");
        }
        return run(op, args);
      };
    }
    const { operation, job } = await archive(f, {
      target: f.home,
      name: "archive.zip",
      options: { output: "file" },
    });
    assert.equal(injected, true);
    const before = await fs.stat(target),
      bytes = await fs.readFile(target);
    await fs.unlink(path.join(f.home, "source"));
    await f.restart();
    const replay = await f.jobs.start(f.scope, operation);
    assert.equal(replay.id, job.id);
    assert.equal((await fs.stat(target)).ino, before.ino);
    assert.deepEqual(await fs.readFile(target), bytes);
    assert.equal(f.store.archives.get(job.id).published, true);
    assert.equal(f.jobs.get(f.scope, job.id).completedEntries, 1);
  });

for (const heldOp of ["openFile", "write"])
  test(`cancel drains a late ${heldOp} before releasing its slot`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.home, "source");
    await fs.writeFile(source, "some source");
    const entered = Promise.withResolvers(),
      gate = Promise.withResolvers(),
      run = f.publisher.native.run.bind(f.publisher.native);
    let held = false;
    f.publisher.native.run = async (op, args) => {
      const result = await run(op, args);
      if (!held && op === heldOp) {
        held = true;
        entered.resolve();
        await gate.promise;
      }
      return result;
    };
    const job = await f.jobs.start(f.scope, archiveOperation([source]));
    try {
      await entered.promise;
      await f.jobs.cancel(f.scope, job.id);
      assert.equal(f.jobs.transfers, 1);
      let barrierAvailable = false;
      await f.barrier.run(() => {
        barrierAvailable = true;
      });
      assert.equal(barrierAvailable, true);
    } finally {
      gate.resolve();
    }
    assert.equal((await f.jobs.join(f.scope, job.id)).status, "cancelled");
    await f.until(() => f.jobs.transfers === 0);
    assert.equal(f.jobs.active.size, 0);
    await assert.rejects(artifactBytes(f, job.id));
  });

for (const decision of ["replace", "keep_both", "skip"])
  test(`public archive honors ${decision} and replay keeps one publication`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.home, "source"),
      target = path.join(f.home, "public.zip");
    await fs.writeFile(source, "ZIP contents");
    await fs.writeFile(target, "old bytes");
    const operation = archiveOperation([source], {
      target: f.home,
      name: "public.zip",
      options: { output: "file" },
    });
    const jobs = await Promise.all([
      f.jobs.start(f.scope, operation),
      f.jobs.start(f.scope, operation),
    ]);
    assert.equal(jobs[0].id, jobs[1].id);
    const job = jobs[0],
      conflict = await f.until(() => f.jobs.get(f.scope, job.id).conflict);
    await f.jobs.resolve(f.scope, job.id, {
      conflictId: conflict.id,
      decision,
      applyToRemaining: false,
    });
    assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
    if (decision === "skip") {
      assert.equal(
        f.jobs.entries(f.scope, job.id).entries.every((e) => e.status === "skipped"),
        true,
      );
      assert.equal(f.store.listPublications().length, 0);
    } else {
      const output =
        decision === "replace" ? target : path.join(f.home, "public (2).zip");
      assert.equal(
        (await zipEntries(await fs.readFile(output))).get("source").toString(),
        "ZIP contents",
      );
      assert.equal(f.store.listPublications().length, 1);
      if (decision === "replace")
        assert.equal(f.store.listTrash(f.scope).entries.length, 1);
    }
    if (decision !== "replace")
      assert.equal(await fs.readFile(target, "utf8"), "old bytes");
    await assert.rejects(artifactBytes(f, job.id), { code: "FILE_NOT_FOUND" });
    assert.equal((await f.jobs.start(f.scope, operation)).id, job.id);
  });

test("a target directory alias changed while streaming cannot redirect publication", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "source"),
    a = path.join(f.home, "a"),
    b = path.join(f.home, "b"),
    alias = path.join(f.home, "alias");
  await fs.writeFile(source, "source");
  await fs.mkdir(a);
  await fs.mkdir(b);
  await fs.symlink(a, alias);
  const checkpoint = f.publisher.checkpointArchive.bind(f.publisher);
  f.publisher.checkpointArchive = async (stage, proof, options) => {
    if (proof) {
      await fs.unlink(alias);
      await fs.symlink(b, alias);
    }
    return checkpoint(stage, proof, options);
  };
  const job = await f.jobs.start(
    f.scope,
    archiveOperation([source], {
      target: alias,
      name: "out.zip",
      options: { output: "file" },
    }),
  );
  assert.equal((await f.jobs.join(f.scope, job.id)).issue.code, "FILE_PATH_CHANGED");
  for (const target of [a, b])
    await assert.rejects(fs.access(path.join(target, "out.zip")), { code: "ENOENT" });
});

test("failed displaced adoption never claims full success and restart completes metadata without replacement replay", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "source"),
    target = path.join(f.home, "public.zip");
  await fs.writeFile(source, "new contents");
  await fs.writeFile(target, "old contents");
  f.trash.adoptDisplaced = async () => {
    throw new Error("durable adoption failure");
  };
  const operation = archiveOperation([source], {
    target: f.home,
    name: "public.zip",
    options: { output: "file" },
  });
  const job = await f.jobs.start(f.scope, operation),
    conflict = await f.until(() => f.jobs.get(f.scope, job.id).conflict);
  await f.jobs.resolve(f.scope, job.id, {
    conflictId: conflict.id,
    decision: "replace",
    applyToRemaining: false,
  });
  assert.notEqual((await f.jobs.join(f.scope, job.id)).status, "completed");
  const before = await fs.stat(target),
    bytes = await fs.readFile(target);
  assert.equal(f.store.listPublications()[0].document.archiveCompleted, true);
  await fs.unlink(source);
  await f.restart();
  assert.equal(f.jobs.get(f.scope, job.id).status, "completed");
  assert.equal(f.store.listTrash(f.scope).entries.length, 1);
  assert.equal((await fs.stat(target)).ino, before.ino);
  assert.deepEqual(await fs.readFile(target), bytes);
  assert.equal((await f.jobs.start(f.scope, operation)).id, job.id);
});
