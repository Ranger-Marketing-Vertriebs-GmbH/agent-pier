import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { uploadFixture, uploadRequest } from "../helpers/file-uploads.js";
import { extractionZip, extractOperation } from "../helpers/file-extract.js";
import { fileProblem } from "../../server/features/files/file-errors.js";
import { entryRevision, resolveFile } from "../../server/features/files/file-paths.js";

const operation = (kind, sources, target, options = {}) => ({
  requestId: uploadRequest(),
  kind,
  sources,
  target,
  name: null,
  options,
});
const settled = async (f, job) => {
  await f.until(() => !f.jobs.owns(job.id));
  return f.jobs.get(f.scope, job.id);
};

test("failed status cannot grant retry authority to published, removed or uncertain entries", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "source");
  await fs.writeFile(source, "bytes");
  const selected = await resolveFile(f.scope, source);
  for (const evidence of [
    { outputPublished: true },
    { sourceRemoved: true },
    { sourceRemovalPending: true },
  ]) {
    const job = await f.barrier.run(() => {
      const job = f.store.request(f.scope, operation("move", [source], f.project)).job;
      f.store.putEntry(job.id, {
        id: "0",
        source,
        path: path.join(f.project, "source"),
        type: "file",
        revision: entryRevision(selected.stat),
        status: "failed",
        ...evidence,
      });
      f.store.transition(job.id, "queued", "failed");
      return job;
    });
    await assert.rejects(f.retries.preview(f.scope, job.id), {
      code: "FILE_RETRY_UNAVAILABLE",
    });
  }
  const extract = await f.barrier.run(() => {
    const job = f.store.request(f.scope, extractOperation(source, f.project)).job;
    f.store.putEntry(job.id, {
      id: "0",
      relative: "output",
      source,
      path: path.join(f.project, "output"),
      type: "file",
      revision: entryRevision(selected.stat),
      status: "failed",
      outputPublished: false,
    });
    f.store.transition(job.id, "queued", "interrupted");
    return job;
  });
  await assert.rejects(f.retries.preview(f.scope, extract.id), {
    code: "FILE_RETRY_UNAVAILABLE",
  });
});
async function partialExtract(f) {
  const source = path.join(f.home, "source.zip");
  await fs.writeFile(
    source,
    extractionZip([
      { name: "folder/a", bytes: "first" },
      { name: "folder/b", bytes: "second" },
    ]),
  );
  await fs.mkdir(path.join(f.project, "folder"));
  const publish = f.publisher.publish.bind(f.publisher);
  let count = 0;
  f.publisher.publish = async (...args) => {
    if (++count === 2) throw fileProblem("FILE_ACCESS_DENIED", 403);
    return publish(...args);
  };
  const job = await f.jobs.start(f.scope, extractOperation(source, f.project));
  await f.until(() => f.jobs.get(f.scope, job.id).conflict);
  await f.jobs.resolve(f.scope, job.id, {
    conflictId: f.jobs.get(f.scope, job.id).conflict.id,
    decision: "merge",
    applyToRemaining: false,
  });
  assert.equal((await settled(f, job)).status, "partially_completed");
  f.publisher.publish = publish;
  return { source, job };
}

test("partial extraction retry omits its completed merged ancestor and preserves its effective target", async (t) => {
  const f = await uploadFixture(t),
    { job } = await partialExtract(f);
  const first = await fs.stat(path.join(f.project, "folder/a"));
  const proposal = await f.retries.preview(f.scope, job.id);
  assert.deepEqual(
    proposal.entries.map((row) => row.path),
    [path.join(f.project, "folder/b")],
  );
  const child = await f.retries.start(f.scope, job.id, {
    requestId: uploadRequest(),
    reference: proposal.reference,
  });
  assert.equal((await settled(f, child)).status, "completed");
  assert.equal((await fs.stat(path.join(f.project, "folder/a"))).ino, first.ino);
  assert.equal(await fs.readFile(path.join(f.project, "folder/b"), "utf8"), "second");
  assert.equal(f.jobs.entries(f.scope, child.id).entries.length, 1);
});

test("unresolved extraction evidence, changed original ZIP and crossed scopes deny a retry", async (t) => {
  const f = await uploadFixture(t),
    { job, source } = await partialExtract(f);
  const proposal = await f.retries.preview(f.scope, job.id);
  await assert.rejects(f.retries.preview(f.projectScope, job.id), {
    code: "FILE_NOT_FOUND",
  });
  const record = f.store
    .listPublications()
    .find((record) => record.jobId === job.id && record.document.extractDiscarded);
  await f.barrier.run(() => f.store.putPublication({ ...record, phase: "interrupted" }));
  await assert.rejects(f.retries.preview(f.scope, job.id), {
    code: "FILE_RETRY_UNAVAILABLE",
  });
  await f.barrier.run(() => f.store.putPublication(record));
  await fs.writeFile(
    source,
    extractionZip([
      { name: "folder/a", bytes: "CHANGED" },
      { name: "folder/b", bytes: "second" },
    ]),
  );
  await assert.rejects(
    f.retries.start(f.scope, job.id, {
      requestId: uploadRequest(),
      reference: proposal.reference,
    }),
    { code: "FILE_RETRY_UNAVAILABLE" },
  );
  assert.equal(await fs.readFile(path.join(f.project, "folder/a"), "utf8"), "first");
  assert.equal(
    f.store.db.prepare("SELECT count(*) AS n FROM jobs WHERE parent_job_id=?").get(job.id)
      .n,
    0,
  );
});

test("queued extraction retry revalidates the original ZIP again before planning", async (t) => {
  const f = await uploadFixture(t),
    { job, source } = await partialExtract(f);
  const proposal = await f.retries.preview(f.scope, job.id);
  const prepare = f.jobs.prepareJob;
  f.jobs.prepareJob = async (...args) => {
    const result = await prepare(...args);
    if (result)
      await fs.writeFile(source, extractionZip([{ name: "folder/b", bytes: "changed" }]));
    return result;
  };
  const child = await f.retries.start(f.scope, job.id, {
    requestId: uploadRequest(),
    reference: proposal.reference,
  });
  assert.equal((await settled(f, child)).issue.code, "FILE_RETRY_UNAVAILABLE");
  await assert.rejects(fs.stat(path.join(f.project, "folder/b")), { code: "ENOENT" });
});

test("copy retry reuses only failed source observations and retains each original destination", async (t) => {
  const f = await uploadFixture(t),
    sources = ["first", "second"].map((name) => path.join(f.home, name));
  for (const source of sources) await fs.writeFile(source, path.basename(source));
  const stage = f.publisher.stage.bind(f.publisher);
  f.publisher.stage = async (...args) => {
    if (args[1] === path.join(f.project, "second"))
      throw fileProblem("FILE_ACCESS_DENIED", 403);
    return stage(...args);
  };
  const job = await f.jobs.start(f.scope, operation("copy", sources, f.project));
  await settled(f, job);
  f.publisher.stage = stage;
  assert.equal(f.jobs.get(f.scope, job.id).status, "partially_completed");
  const proposal = await f.retries.preview(f.scope, job.id);
  assert.equal(proposal.totalEntries, 1);
  const child = await f.retries.start(f.scope, job.id, {
    requestId: uploadRequest(),
    reference: proposal.reference,
  });
  assert.equal((await settled(f, child)).status, "completed");
  assert.equal(await fs.readFile(path.join(f.project, "second"), "utf8"), "second");
});

test("retry proposal pages are bound to a complete unchanged terminal selection", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "source.zip");
  await fs.writeFile(source, extractionZip([{ name: "a", bytes: "a" }]));
  const selected = await resolveFile(f.scope, source);
  const job = await f.barrier.run(
    () => f.store.request(f.scope, extractOperation(source, f.project)).job,
  );
  await f.barrier.run(() => {
    f.store.transition(job.id, "queued", "interrupted");
    f.store.setJobDetails(job.id, {
      extractSource: {
        revision: entryRevision(selected.stat, selected.linkIdentity),
        absolute: selected.absolute,
        linkIdentity: selected.linkIdentity,
      },
    });
    for (let index = 0; index < 201; index++)
      f.store.putEntry(job.id, {
        id: String(index),
        source,
        relative: `failed-${index}`,
        path: path.join(f.project, `failed-${index}`),
        type: "file",
        status: "failed",
      });
  });
  const first = await f.retries.preview(f.scope, job.id);
  assert.equal(first.entries.length, 200);
  const second = await f.retries.preview(f.scope, job.id, first.nextCursor);
  assert.equal(second.entries.length, 1);
  assert.equal(second.reference, first.reference);
  await f.barrier.run(() =>
    f.store.putEntry(job.id, {
      ...f.store.getEntry(job.id, "200"),
      status: "completed",
      outputPublished: true,
    }),
  );
  await assert.rejects(f.retries.preview(f.scope, job.id, first.nextCursor), {
    code: "FILE_INVALID_CURSOR",
  });
});
