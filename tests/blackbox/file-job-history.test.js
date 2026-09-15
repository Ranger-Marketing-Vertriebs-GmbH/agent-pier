import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { waitForFileJob } from "../helpers/file-explorer.js";
import { uploadRequest } from "../helpers/file-uploads.js";
import { extractionZip, extractOperation } from "../helpers/file-extract.js";
import { fileProblem } from "../../server/features/files/file-errors.js";

test("archive history projects proven download readiness without private artifact data", async (t) => {
  const f = await applicationFixture(t);
  const source = path.join(f.home, "source.txt");
  await fs.writeFile(source, "real archive bytes");
  const { scopeId } = await (await f.request("/api/files/context")).json();
  const started = await f.request("/api/files/operations", {
    method: "POST",
    headers: { "X-File-Scope": scopeId },
    body: {
      requestId: uploadRequest(),
      kind: "archive",
      sources: [source],
      target: null,
      name: null,
      options: { output: "download" },
    },
  });
  assert.equal(started.status, 202);
  const job = await waitForFileJob(f, (await started.json()).id);
  assert.equal(job.status, "completed");
  assert.equal(job.artifactReady, true);
  assert.equal(JSON.stringify(job).includes(f.dataDir), false);
  const listed = await (await f.request("/api/files/jobs")).json();
  assert.equal(listed.jobs.find((entry) => entry.id === job.id).artifactReady, true);
  const files = f.application.files,
    scope = await files.context();
  const record = files.store.getPublication(
    files.store.archives.get(job.id).publicationId,
  );
  const original = structuredClone(record.document);
  for (const patch of [
    { archiveChanged: true },
    { archiveDiscarded: true },
    { archiveValidated: null },
  ]) {
    await files.publisher.barrier.run(() =>
      files.store.putPublication({ ...record, document: { ...original, ...patch } }),
    );
    assert.equal(files.jobs.get(scope, job.id).artifactReady, false);
  }
  await files.publisher.barrier.run(() =>
    files.store.putPublication({ ...record, document: original }),
  );
  const downloaded = await f.request(`/api/files/jobs/${job.id}/download`);
  assert.equal(downloaded.status, 200);
  assert.equal(
    Buffer.from(await downloaded.arrayBuffer())
      .subarray(0, 2)
      .toString(),
    "PK",
  );
});

test("server-issued extraction retry selects failed members and preserves completed outputs", async (t) => {
  const f = await applicationFixture(t);
  const source = path.join(f.home, "source.zip"),
    target = path.join(f.home, "target");
  await fs.mkdir(target);
  await fs.writeFile(
    source,
    extractionZip([
      { name: "a.txt", bytes: "first" },
      { name: "b.txt", bytes: "second" },
    ]),
  );
  const files = f.application.files;
  const publish = files.publisher.publish.bind(files.publisher);
  let calls = 0;
  files.publisher.publish = async (...args) => {
    if (++calls === 2) throw fileProblem("FILE_ACCESS_DENIED", 403);
    return publish(...args);
  };
  const { scopeId } = await (await f.request("/api/files/context")).json();
  const headers = { "X-File-Scope": scopeId };
  const started = await f.request("/api/files/operations", {
    method: "POST",
    headers,
    body: extractOperation(source, target),
  });
  const job = await waitForFileJob(f, (await started.json()).id);
  assert.equal(job.status, "partially_completed");
  const first = await fs.stat(path.join(target, "a.txt"));
  files.publisher.publish = publish;
  const preview = await f.request(`/api/files/jobs/${job.id}/retry`);
  assert.equal(preview.status, 200);
  const proposal = await preview.json();
  const originalRows = await (
    await f.request(`/api/files/jobs/${job.id}/entries`)
  ).json();
  assert.equal(proposal.totalEntries, 1);
  assert.equal(proposal.entries[0].path, path.join(target, "b.txt"));
  assert.equal(JSON.stringify(proposal).includes(f.dataDir), false);
  assert.deepEqual(Object.keys(proposal).sort(), [
    "entries",
    "nextCursor",
    "reference",
    "totalEntries",
  ]);
  const forged = await f.request(`/api/files/jobs/${job.id}/retry`, {
    method: "POST",
    headers,
    body: {
      requestId: uploadRequest(),
      reference: `r1:${"0".repeat(64)}`,
    },
  });
  assert.equal(forged.status, 409);
  assert.equal(
    (
      await f.request(`/api/files/jobs/${job.id}/retry`, {
        method: "POST",
        body: {
          requestId: uploadRequest(),
          reference: proposal.reference,
        },
      })
    ).status,
    409,
  );
  const body = { requestId: uploadRequest(), reference: proposal.reference };
  const retried = await f.request(`/api/files/jobs/${job.id}/retry`, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(retried.status, 202);
  const child = await retried.json();
  assert.notEqual(child.id, job.id);
  assert.equal((await waitForFileJob(f, child.id)).status, "completed");
  assert.equal((await fs.stat(path.join(target, "a.txt"))).ino, first.ino);
  assert.equal(await fs.readFile(path.join(target, "b.txt"), "utf8"), "second");
  const replay = await f.request(`/api/files/jobs/${job.id}/retry`, {
    method: "POST",
    headers,
    body,
  });
  assert.equal((await replay.json()).id, child.id);
  assert.equal(
    (await (await f.request(`/api/files/jobs/${job.id}`)).json()).status,
    "partially_completed",
  );
  assert.equal((await f.request(`/api/files/jobs/${job.id}/retry`)).status, 409);
  const mismatch = await f.request(`/api/files/jobs/${job.id}/retry`, {
    method: "POST",
    headers,
    body: { ...body, reference: `r1:${"f".repeat(64)}` },
  });
  assert.equal(mismatch.status, 409);
  assert.deepEqual(
    await (await f.request(`/api/files/jobs/${job.id}/entries`)).json(),
    originalRows,
  );
  await f.restart();
  const restartedReplay = await f.request(`/api/files/jobs/${job.id}/retry`, {
    method: "POST",
    headers,
    body,
  });
  assert.equal(restartedReplay.status, 202);
  assert.equal((await restartedReplay.json()).id, child.id);
});
