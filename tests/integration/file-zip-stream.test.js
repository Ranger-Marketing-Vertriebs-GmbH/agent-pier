import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { progressPatch } from "../../server/features/files/file-job-handlers.js";
import { uploadFixture } from "../helpers/file-uploads.js";
import { archiveOperation, artifactBytes, zipEntries } from "../helpers/file-archives.js";
import {
  archiveOutputLimit,
  archivePath,
} from "../../server/features/files/file-archive-paths.js";

for (const kind of ["append", "same-size", "missing"])
  test(`actual ${kind} before source read prevents a complete artifact`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.project, "source");
    await fs.writeFile(source, "old");
    const native = f.publisher.native,
      run = native.run.bind(native);
    let injected = false;
    native.run = async (op, args) => {
      if (!injected && op === "openFile" && args.path?.endsWith("source")) {
        injected = true;
        if (kind === "missing") await fs.unlink(source);
        else if (kind === "append") await fs.appendFile(source, "growth");
        else await fs.writeFile(source, "new");
      }
      return run(op, args);
    };
    const job = await f.jobs.start(f.scope, archiveOperation([source]));
    assert.equal((await f.jobs.join(f.scope, job.id)).status, "failed");
    assert.equal(injected, true);
    await assert.rejects(artifactBytes(f, job.id), { code: "FILE_ARCHIVE_PENDING" });
    assert.ok(f.store.listPublications().every((p) => p.phase === "resolved"));
  });

test("incompressible payload at the job cap succeeds despite ZIP overhead and upload-only cap", async (t) => {
  const bytes = randomBytes(65536),
    f = await uploadFixture(t, { jobBytes: bytes.length, uploadBytes: 1 });
  const source = path.join(f.home, "bytes");
  await fs.writeFile(source, bytes);
  const job = await f.jobs.start(f.scope, archiveOperation([source]));
  const result = await f.jobs.join(f.scope, job.id);
  assert.equal(result.status, "completed", JSON.stringify(result));
  assert.equal(result.completedBytes, bytes.length);
  const output = await artifactBytes(f, job.id);
  assert.ok(output.length > bytes.length);
  assert.deepEqual((await zipEntries(output)).get("bytes"), bytes);
});

test("aggregate roots and safe output arithmetic enforce actual independent bounds", async (t) => {
  assert.ok(archiveOutputLimit(2 ** 32 + 1, ["a"]) > 2 ** 33);
  assert.equal(
    progressPatch({ completedBytes: 2 ** 32 + 1 }, { jobBytes: 50 * 2 ** 30 }, "archive")
      .completedBytes,
    2 ** 32 + 1,
  );
  assert.throws(() => archiveOutputLimit(Number.MAX_SAFE_INTEGER, ["a"]), {
    code: "FILE_LIMIT_EXCEEDED",
  });
  for (const name of ["/a", "a/../b", "a\\b", "C:foo", "a//b", "\ud800"])
    assert.throws(() => archivePath(name));
  const f = await uploadFixture(t, { jobBytes: 3 }),
    sources = [path.join(f.home, "a"), path.join(f.home, "b")];
  for (const source of sources) await fs.writeFile(source, "12");
  const job = await f.jobs.start(f.scope, archiveOperation(sources));
  assert.equal((await f.jobs.join(f.scope, job.id)).issue.code, "FILE_LIMIT_EXCEEDED");
  assert.equal(f.store.listPublications().length, 0);
});

for (const failure of ["write", "report"])
  test(`${failure} failure stops reads, drains and preserves the first issue`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.home, "source");
    await fs.writeFile(source, randomBytes(262144));
    let observed = false;
    if (failure === "write") {
      const run = f.publisher.native.run.bind(f.publisher.native);
      f.publisher.native.run = (op, args) => {
        if (op === "write") {
          observed = true;
          throw Object.assign(new Error("private disk diagnostic"), { code: "ENOSPC" });
        }
        return run(op, args);
      };
    } else {
      const report = f.jobs.report.bind(f.jobs);
      f.jobs.report = (item, patch) => {
        if (patch.completedBytes > 0) {
          observed = true;
          throw Object.assign(new Error("private SQL diagnostic"), {
            code: "SQLITE_FULL",
          });
        }
        return report(item, patch);
      };
    }
    const job = await f.jobs.start(f.scope, archiveOperation([source]));
    const result = await f.jobs.join(f.scope, job.id);
    assert.equal(observed, true);
    assert.equal(result.status, "failed");
    assert.deepEqual(result.issue, { code: "FILE_IO_ERROR", args: {} });
    await f.until(() => f.jobs.transfers === 0);
    assert.equal(f.jobs.active.size, 0);
    await assert.rejects(artifactBytes(f, job.id));
  });

for (const change of ["append", "same-size", "short", "io"])
  test(`owned input detects ${change} during its second read and drains`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.home, "source");
    await fs.writeFile(source, Buffer.alloc(196608, 42));
    const run = f.publisher.native.run.bind(f.publisher.native);
    let handle,
      reads = 0,
      injected = false;
    f.publisher.native.run = async (op, args) => {
      if (op === "openFile" && args.path?.endsWith("source")) {
        const opened = await run(op, args);
        handle = opened.handle;
        return opened;
      }
      if (op === "read" && args.handle === handle && ++reads === 2) {
        injected = true;
        if (change === "io")
          throw Object.assign(new Error("input diagnostic"), { code: "EIO" });
        if (change === "append") await fs.appendFile(source, "growth");
        else
          await fs.writeFile(source, Buffer.alloc(change === "short" ? 1 : 196608, 43));
      }
      return run(op, args);
    };
    const job = await f.jobs.start(f.scope, archiveOperation([source]));
    assert.equal((await f.jobs.join(f.scope, job.id)).status, "failed");
    assert.equal(injected, true);
    assert.equal(reads, 2);
    await f.until(() => f.jobs.transfers === 0);
    await assert.rejects(artifactBytes(f, job.id));
  });

test("slow progress owns the input read and a final manifest change prevents readiness", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.project, "source");
  await fs.writeFile(source, Buffer.alloc(196608));
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const report = f.jobs.report.bind(f.jobs),
    run = f.publisher.native.run.bind(f.publisher.native);
  let pending = false,
    readsDuringReport = 0,
    held = false;
  f.publisher.native.run = (op, args) => {
    if (pending && op === "read") readsDuringReport++;
    return run(op, args);
  };
  f.jobs.report = async (item, patch) => {
    if (patch.completedBytes > 0 && !held) {
      held = pending = true;
      entered.resolve();
      await gate.promise;
      pending = false;
    }
    return report(item, patch);
  };
  const checkpoint = f.publisher.checkpointArchive.bind(f.publisher);
  f.publisher.checkpointArchive = async (stage, proof, options) => {
    if (proof) await fs.writeFile(path.join(f.project, "late"), "new required source");
    return checkpoint(stage, proof, options);
  };
  const job = await f.jobs.start(f.scope, archiveOperation([f.project]));
  try {
    await entered.promise;
    await f.barrier.snapshot(() => assert.equal(f.jobs.transfers, 1));
    assert.equal(readsDuringReport, 0);
  } finally {
    gate.resolve();
  }
  assert.equal((await f.jobs.join(f.scope, job.id)).issue.code, "FILE_CONFLICT_CHANGED");
  await assert.rejects(artifactBytes(f, job.id));
});

for (const emitter of ["zip", "output"])
  test(`${emitter} errors before lazy completion are owned and drain without later opens`, async (t) => {
    const f = await uploadFixture(t),
      source = path.join(f.home, "source");
    await fs.writeFile(source, "source");
    const { default: yazl } = await import("yazl");
    const original = yazl.ZipFile.prototype.end;
    let failed = false,
      laterOpens = 0;
    const run = f.publisher.native.run.bind(f.publisher.native);
    f.publisher.native.run = (op, args) => {
      if (failed && op === "openFile") laterOpens++;
      return run(op, args);
    };
    yazl.ZipFile.prototype.end = function () {
      failed = true;
      const error = Object.assign(new Error("private ZIP failure"), {
        code: "FILE_LIMIT_EXCEEDED",
      });
      if (emitter === "zip") this.emit("error", error);
      else this.outputStream.destroy(error);
    };
    try {
      const job = await f.jobs.start(f.scope, archiveOperation([source]));
      assert.equal(
        (await f.jobs.join(f.scope, job.id)).issue.code,
        "FILE_LIMIT_EXCEEDED",
      );
      await f.until(() => f.jobs.transfers === 0);
      assert.equal(laterOpens, 0);
    } finally {
      yazl.ZipFile.prototype.end = original;
    }
  });
