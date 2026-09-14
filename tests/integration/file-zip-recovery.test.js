import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture } from "../helpers/file-uploads.js";
import { archiveOperation, artifactBytes, zipEntries } from "../helpers/file-archives.js";
import { archiveManifest } from "../../server/features/files/file-archive-plan.js";
import { writeArchive } from "../../server/features/files/file-archive-stream.js";

async function staged(f) {
  const source = path.join(f.home, "source");
  await fs.writeFile(source, "recover without rereading");
  const operation = archiveOperation([source]);
  const { job } = f.store.request(f.scope, operation);
  f.store.transition(job.id, "queued", "running");
  const context = {
    scope: f.scope,
    operation,
    signal: new AbortController().signal,
    report: async () => {},
  };
  const plan = await archiveManifest(f.archives, context);
  f.store.archives.plan(f.scope, job.id, {
    ...plan,
    mode: "download",
    target: null,
    name: "archive.zip",
  });
  const target = f.store.archives.target(f.scope, job.id);
  f.store.archives.save(job.id, { ...f.store.archives.get(job.id), target });
  const stage = await f.publisher.stage(f.scope, target, {
    jobId: job.id,
    archive: true,
  });
  return { source, operation, job, context, plan, stage };
}

for (const phase of ["proof", "completion"])
  test(`startup reconciles private ${phase} without any source or re-creation`, async (t) => {
    const f = await uploadFixture(t),
      s = await staged(f);
    const proof = await writeArchive(f.archives, s.context, s.plan, s.stage);
    await f.publisher.checkpointArchive(s.stage, proof);
    const record = f.store.getPublication(f.store.archives.get(s.job.id).publicationId);
    if (phase === "completion") f.store.archives.complete(record);
    const before = await fs.stat(record.document.staged);
    await f.publisher.release(s.stage);
    await fs.unlink(s.source);
    await f.restart();
    assert.equal(f.jobs.get(f.scope, s.job.id).status, "completed");
    assert.equal((await fs.stat(record.document.staged)).ino, before.ino);
    assert.equal(
      (await zipEntries(await artifactBytes(f, s.job.id))).get("source").toString(),
      "recover without rereading",
    );
    assert.equal((await f.jobs.start(f.scope, s.operation)).id, s.job.id);
    assert.equal(f.store.listPublications().length, 1);
  });

for (const state of ["partial", "failed", "cancelled", "tampered"])
  test(`startup never exposes ${state} private ZIP bytes`, async (t) => {
    const f = await uploadFixture(t),
      s = await staged(f);
    const proof = await writeArchive(f.archives, s.context, s.plan, s.stage);
    if (state !== "partial") await f.publisher.checkpointArchive(s.stage, proof);
    const record = f.store.getPublication(f.store.archives.get(s.job.id).publicationId);
    await f.publisher.release(s.stage);
    if (["failed", "cancelled"].includes(state))
      f.store.transition(s.job.id, "running", state);
    if (state === "tampered") await fs.appendFile(record.document.staged, "tamper");
    await f.restart();
    await assert.rejects(artifactBytes(f, s.job.id), { code: "FILE_ARCHIVE_PENDING" });
    assert.notEqual(f.jobs.get(f.scope, s.job.id).status, "completed");
  });

for (const cap of ["source", "output"])
  test(`actual ${cap} overflow fails the stream before an over-budget native write`, async (t) => {
    const f = await uploadFixture(t),
      s = await staged(f);
    let written = 0;
    const run = f.publisher.native.run.bind(f.publisher.native);
    f.publisher.native.run = (op, args) => {
      if (op === "write") written += args.bytes.length;
      return run(op, args);
    };
    const plan = { ...s.plan, ...(cap === "output" ? { outputLimit: 1 } : { bytes: 0 }) };
    await assert.rejects(writeArchive(f.archives, s.context, plan, s.stage), {
      code: "FILE_LIMIT_EXCEEDED",
    });
    if (cap === "output") assert.equal(written, 0);
    await f.publisher.discard(s.stage);
    assert.equal(
      f.store.getPublication(f.store.archives.get(s.job.id).publicationId).phase,
      "resolved",
    );
  });

test("successful restart preserves the terminal retention clock", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "source");
  await fs.writeFile(source, "source");
  const job = await f.jobs.start(f.scope, archiveOperation([source]));
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
  const old = Date.now() - 86400000;
  f.store.db.prepare("UPDATE jobs SET updated_at=? WHERE id=?").run(old, job.id);
  await f.restart();
  assert.equal(
    f.store.db.prepare("SELECT updated_at FROM jobs WHERE id=?").get(job.id).updated_at,
    old,
  );
  assert.ok((await artifactBytes(f, job.id)).length > 0);
});

test("proven expired artifact is scoped not-found before the next metadata prune", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "source");
  await fs.writeFile(source, "source");
  const job = await f.jobs.start(f.scope, archiveOperation([source]));
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
  await f.archives.sweep(Date.now() + 8 * 86400000);
  await assert.rejects(artifactBytes(f, job.id), { code: "FILE_NOT_FOUND" });
});
