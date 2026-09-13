import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { uploadFixture } from "../helpers/file-uploads.js";
import { downloadFile } from "../../server/features/files/file-downloads.js";
import { makeFileScope } from "../../server/features/files/file-scope.js";

function response(write = (chunk, encoding, done) => done()) {
  const result = new Writable({ highWaterMark: 65536, write });
  result.headers = new Map();
  result.setHeader = (name, value) => result.headers.set(name, value);
  return result;
}

test("direct downloads queue behind the same three upload slots with no early handles or public job", async (t) => {
  const f = await uploadFixture(t),
    streams = [],
    uploads = [];
  for (let i = 0; i < 3; i++) {
    const { uploadId } = await f.create(`active-${i}`, 2);
    const stream = new PassThrough();
    streams.push(stream);
    uploads.push(f.uploads.receive(f.scope, uploadId, stream));
    stream.write("a");
    await f.until(() => f.jobs.get(f.scope, uploadId).completedBytes === 1);
  }
  const selected = path.join(f.home, "download");
  await fs.writeFile(selected, "exact bytes");
  const sink = response(),
    controller = new AbortController();
  const before = f.store.db.prepare("SELECT count(*) AS n FROM jobs").get().n;
  const queued = f.jobs.runDirectTransfer(
    f.scope,
    ({ scope, signal }) => downloadFile(scope, selected, sink, { signal }),
    { signal: controller.signal },
  );
  const outcome = assert.rejects(queued, { name: "AbortError" });
  assert.equal(f.jobs.transfers, 3);
  assert.equal(f.jobs.pending.filter((item) => item.ephemeral).length, 1);
  assert.equal(sink.headers.size, 0);
  controller.abort();
  await outcome;
  assert.equal(f.jobs.pending.length, 0);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM jobs").get().n, before);
  for (const stream of streams) stream.end("b");
  assert.deepEqual(
    (await Promise.all(uploads)).map((job) => job.status),
    ["completed", "completed", "completed"],
  );
});

test("admitted download retains its slot through backpressure and close aborts and drains it", async (t) => {
  const f = await uploadFixture(t),
    selected = path.join(f.home, "large");
  await fs.writeFile(selected, Buffer.alloc(262144, 42));
  let written = 0;
  const sink = response((chunk) => {
    written += chunk.length;
  });
  const done = f.jobs.runDirectTransfer(f.scope, ({ scope, signal }) =>
    downloadFile(scope, selected, sink, { signal }),
  );
  const outcome = assert.rejects(done);
  await f.until(() => written > 0);
  assert.equal(f.jobs.transfers, 1);
  await f.barrier.snapshot(() => assert.equal(f.barrier.exclusive, true));
  const beforeStoreClose = f.jobs.beforeStoreClose;
  f.jobs.beforeStoreClose = async () => {
    assert.equal(f.jobs.transfers, 0);
    assert.equal(f.jobs.active.size, 0);
    assert.equal(f.jobs.workers.size, 0);
    assert.equal(sink.destroyed, true);
    await beforeStoreClose();
  };
  await f.close();
  await outcome;
});

test("direct download refreshes readonly scope after admission and rejects scope changes", async (t) => {
  const f = await uploadFixture(t);
  const readonly = await makeFileScope({
    home: f.home,
    session: { id: "fixture", cwd: f.project, pipeline: { headless: true } },
  });
  await fs.writeFile(path.join(f.project, "read"), "readonly");
  f.jobs.context = async () => readonly;
  const bytes = [],
    sink = response((chunk, encoding, done) => {
      bytes.push(chunk);
      done();
    });
  await f.jobs.runDirectTransfer(readonly, ({ scope, signal }) => {
    assert.equal(scope.readOnly, true);
    return downloadFile(scope, "read", sink, { signal });
  });
  assert.equal(Buffer.concat(bytes).toString(), "readonly");
  const stale = response();
  await assert.rejects(
    f.jobs.runDirectTransfer(f.projectScope, ({ scope, signal }) =>
      downloadFile(scope, "read", stale, { signal }),
    ),
    { code: "FILE_INVALID_SCOPE" },
  );
  assert.equal(stale.headers.size, 0);
});

test("download closes an already started response on a source mutation without appending JSON", async (t) => {
  const f = await uploadFixture(t),
    selected = path.join(f.home, "mutating");
  await fs.writeFile(selected, Buffer.alloc(131072, 42));
  let first = true;
  const sink = response((chunk, encoding, done) => {
    if (!first) return done();
    first = false;
    fs.writeFile(selected, "changed").then(() => done(), done);
  });
  await assert.rejects(
    f.jobs.runDirectTransfer(f.scope, ({ scope, signal }) =>
      downloadFile(scope, selected, sink, { signal }),
    ),
    { code: "FILE_PATH_CHANGED" },
  );
  assert.equal(sink.destroyed, true);
});
