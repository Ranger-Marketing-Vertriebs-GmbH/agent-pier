import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { uploadFixture } from "../helpers/file-uploads.js";
import { archiveOperation, artifactBytes } from "../helpers/file-archives.js";
import { makeFileScope } from "../../server/features/files/file-scope.js";

async function ready(f) {
  const source = path.join(f.home, "source");
  await fs.writeFile(source, "artifact bytes");
  const job = await f.jobs.start(f.scope, archiveOperation([source]));
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
  return job;
}

test("uploads, copy, archive and artifact reads consume the same three slots", async (t) => {
  const f = await uploadFixture(t),
    artifact = await ready(f);
  const body = new PassThrough();
  const upload = await f.create("upload", 2);
  const receiving = f.uploads.receive(f.scope, upload.uploadId, body);
  body.write("a");
  await f.until(() => f.jobs.get(f.scope, upload.uploadId).completedBytes === 1);
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const run = f.publisher.native.run.bind(f.publisher.native);
  let held = 0;
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (op === "write" && held < 2) {
      if (++held === 2) entered.resolve();
      await gate.promise;
    }
    return result;
  };
  const source = path.join(f.home, "source");
  const copy = await f.jobs.start(f.scope, {
    ...archiveOperation([source]),
    kind: "copy",
    target: f.project,
    options: {},
  });
  const zip = await f.jobs.start(f.scope, archiveOperation([source]));
  const controller = new AbortController();
  let headers = 0;
  const sink = new Writable({
    write(c, e, cb) {
      cb();
    },
  });
  sink.setHeader = () => headers++;
  let rejected;
  try {
    await entered.promise;
    assert.equal(f.jobs.transfers, 3);
    const download = f.archives.downloadJobArtifact(f.scope, artifact.id, sink, {
      signal: controller.signal,
    });
    rejected = assert.rejects(download);
    await f.until(() => f.archives.claims.has(artifact.id));
    assert.equal(headers, 0);
    assert.equal(f.jobs.pending.filter((p) => p.ephemeral).length, 1);
    await f.archives.sweep(Date.now() + 8 * 86400000);
    controller.abort();
    await rejected;
  } finally {
    controller.abort();
    gate.resolve();
    body.end("b");
    await receiving;
  }
  for (const job of [copy, zip])
    assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
  assert.equal(f.archives.claims.size, 0);
});

test("artifact close drains a late open and removes its claim before store/native close", async (t) => {
  const f = await uploadFixture(t),
    job = await ready(f);
  const gate = Promise.withResolvers(),
    entered = Promise.withResolvers();
  const run = f.publisher.native.run.bind(f.publisher.native);
  let held = false;
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (op === "openFile" && !held) {
      held = true;
      entered.resolve();
      await gate.promise;
    }
    return result;
  };
  const getting = artifactBytes(f, job.id),
    outcome = assert.rejects(getting);
  await entered.promise;
  const beforeClose = f.jobs.beforeStoreClose;
  f.jobs.beforeStoreClose = async () => {
    assert.equal(f.jobs.transfers, 0);
    assert.equal(f.archives.claims.size, 0);
    await beforeClose();
  };
  let finished = false;
  const closing = f.close().then(() => {
    finished = true;
  });
  try {
    await f.barrier.snapshot(() => {});
    assert.equal(finished, false);
    assert.equal(f.jobs.transfers, 1);
    assert.equal(f.archives.claims.get(job.id), 1);
  } finally {
    gate.resolve();
  }
  await closing;
  await outcome;
});

test("queued archive uses its immutable download mode in a fresh headless scope", async (t) => {
  const f = await uploadFixture(t);
  const current = await makeFileScope({
    home: f.home,
    session: { id: "fixture", cwd: f.project, pipeline: { headless: true } },
  });
  f.jobs.context = async () => current;
  await fs.writeFile(path.join(f.project, "source"), "read");
  const gate = Promise.withResolvers();
  const owners = Array.from({ length: 3 }, () =>
    f.jobs.runDirectTransfer(current, () => gate.promise),
  );
  await f.until(() => f.jobs.transfers === 3);
  const operation = archiveOperation(["source"]);
  const download = await f.jobs.start(current, operation);
  operation.options.output = "file";
  gate.resolve();
  await Promise.all(owners);
  assert.equal((await f.jobs.join(current, download.id)).status, "completed");
  assert.ok((await artifactBytes(f, download.id, current)).length > 0);
});

test("output-file completion refreshes read-only authority after streaming", async (t) => {
  const f = await uploadFixture(t);
  let current = f.projectScope;
  f.jobs.context = async () => current;
  await fs.writeFile(path.join(f.project, "source"), "read");
  const checkpoint = f.publisher.checkpointArchive.bind(f.publisher);
  f.publisher.checkpointArchive = async (stage, proof, options) => {
    if (proof)
      current = await makeFileScope({
        home: f.home,
        session: { id: "fixture", cwd: f.project, pipeline: { headless: true } },
      });
    return checkpoint(stage, proof, options);
  };
  const job = await f.jobs.start(
    current,
    archiveOperation(["source"], {
      target: "",
      name: "out.zip",
      options: { output: "file" },
    }),
  );
  assert.equal((await f.jobs.join(current, job.id)).issue.code, "FILE_INVALID_SCOPE");
  await assert.rejects(fs.access(path.join(f.project, "out.zip")), { code: "ENOENT" });
});

test("queued artifact rejects a changed scope without opening any artifact handle", async (t) => {
  const f = await uploadFixture(t),
    job = await ready(f);
  const gate = Promise.withResolvers();
  const owners = Array.from({ length: 3 }, () =>
    f.jobs.runDirectTransfer(f.scope, () => gate.promise),
  );
  await f.until(() => f.jobs.transfers === 3);
  const run = f.publisher.native.run.bind(f.publisher.native);
  let opens = 0;
  f.publisher.native.run = (op, args) => {
    if (["openFile", "openRoot"].includes(op)) opens++;
    return run(op, args);
  };
  const getting = artifactBytes(f, job.id),
    rejected = assert.rejects(getting, { code: "FILE_INVALID_SCOPE" });
  await f.until(() => f.archives.claims.has(job.id));
  f.jobs.context = async () => f.projectScope;
  gate.resolve();
  await Promise.all(owners);
  await rejected;
  assert.equal(opens, 0);
  assert.equal(f.archives.claims.size, 0);
});

test("cancelling the finished-payload proof drains its read and never starts another", async (t) => {
  const f = await uploadFixture(t),
    source = path.join(f.home, "source");
  await fs.writeFile(source, randomBytes(262144));
  const entered = Promise.withResolvers(),
    gate = Promise.withResolvers();
  const checkpoint = f.publisher.checkpointArchive.bind(f.publisher);
  const run = f.publisher.native.run.bind(f.publisher.native);
  let proofPhase = false,
    proofReads = 0;
  f.publisher.checkpointArchive = (stage, proof, options) => {
    if (proof) proofPhase = true;
    return checkpoint(stage, proof, options);
  };
  f.publisher.native.run = async (op, args) => {
    const result = await run(op, args);
    if (proofPhase && op === "read") {
      proofReads++;
      if (proofReads === 1) {
        entered.resolve();
        await gate.promise;
      }
    }
    return result;
  };
  const job = await f.jobs.start(f.scope, archiveOperation([source]));
  try {
    await entered.promise;
    await f.jobs.cancel(f.scope, job.id);
    assert.equal(f.jobs.transfers, 1);
  } finally {
    gate.resolve();
  }
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "cancelled");
  assert.equal(proofReads, 1);
  await assert.rejects(artifactBytes(f, job.id));
});

test("public archive traversal and proof reads never hold a physical mutation lease", async (t) => {
  const f = await uploadFixture(t);
  await fs.writeFile(path.join(f.project, "source"), "source");
  const run = f.publisher.native.run.bind(f.publisher.native);
  let leasedReads = 0;
  f.publisher.native.run = (op, args) => {
    if (["read", "readDirectory"].includes(op) && f.barrier.hasLease()) leasedReads++;
    return run(op, args);
  };
  const job = await f.jobs.start(
    f.scope,
    archiveOperation([f.project], {
      target: f.home,
      name: "public.zip",
      options: { output: "file" },
    }),
  );
  assert.equal((await f.jobs.join(f.scope, job.id)).status, "completed");
  assert.equal(leasedReads, 0);
});
