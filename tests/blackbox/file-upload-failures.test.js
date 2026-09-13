import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { uploadRequest } from "../helpers/file-uploads.js";

async function until(condition) {
  for (let n = 0; n < 500; n++) {
    if (await condition()) return;
    await delay(10);
  }
  assert.fail("HTTP upload did not reach the observed state");
}
async function pausedUpload(f, name, bytes = 2) {
  const files = f.application.files,
    scope = await files.context();
  const created = await f.request("/api/files/uploads", {
    method: "POST",
    headers: { "X-File-Scope": scope.id },
    body: { requestId: uploadRequest(), path: f.home, name, bytes },
  });
  assert.equal(created.status, 201);
  const { uploadId } = await created.json(),
    transport = Promise.withResolvers(),
    closed = Promise.withResolvers();
  const request = http.request(`${f.url}/api/files/uploads/${uploadId}/content`, {
    method: "PUT",
    headers: {
      cookie: f.cookie,
      origin: f.url,
      "X-File-Scope": scope.id,
      "Content-Type": "application/octet-stream",
      "Content-Length": bytes,
    },
  });
  request.on("response", (response) => {
    response.resume();
    response.on("end", () => transport.resolve({ status: response.statusCode }));
  });
  request.on("error", (error) => transport.resolve({ error: error.code }));
  request.once("close", closed.resolve);
  return {
    files,
    scope,
    uploadId,
    request,
    transport: transport.promise,
    async close() {
      request.destroy();
      await closed.promise;
    },
  };
}
async function drained(upload) {
  const { files } = upload;
  await until(
    () =>
      files.jobs.transfers === 0 &&
      files.jobs.workers.size === 0 &&
      files.uploads.receivers.size === 0,
  );
  assert.equal(files.jobs.pending.length, 0);
  assert.equal(files.jobs.active.size, 0);
  assert.equal(files.store.listPublications().at(-1).phase, "resolved");
}

for (const failing of ["native write", "progress persistence"])
  test(`paused HTTP upload preserves its durable failure when ${failing} rejects`, async (t) => {
    const f = await applicationFixture(t),
      files = f.application.files;
    let failed = false;
    if (failing === "native write") {
      const native = files.publisher.native,
        run = native.run.bind(native);
      native.run = (operation, args) => {
        if (operation !== "write") return run(operation, args);
        failed = true;
        return Promise.reject(
          Object.assign(new Error("private HTTP disk evidence"), { code: "ENOSPC" }),
        );
      };
    } else
      files.store.uploads.charge = () => {
        failed = true;
        throw Object.assign(new Error("private HTTP persistence evidence"), {
          code: "SQLITE_FULL",
        });
      };
    const upload = await pausedUpload(f, "failed");
    try {
      upload.request.write("a");
      await until(() => failed);
      await drained(upload);
      // The client has supplied one byte and has not ended or aborted its body.
      assert.equal(upload.request.writableEnded, false);
      const response = await f.request(`/api/files/jobs/${upload.uploadId}`);
      assert.equal(response.status, 200);
      const job = await response.json();
      assert.equal(job.status, "failed");
      assert.deepEqual(job.issue, { code: "FILE_IO_ERROR", args: {} });
      assert.equal(JSON.stringify(job).includes("private HTTP"), false);
      await assert.rejects(fs.stat(path.join(f.home, "failed")), { code: "ENOENT" });
    } finally {
      await upload.close();
    }
  });

test("a genuine paused node:http client disconnect still cancels and drains its upload", async (t) => {
  const f = await applicationFixture(t),
    upload = await pausedUpload(f, "disconnect");
  try {
    upload.request.write("a");
    await until(
      () => upload.files.jobs.get(upload.scope, upload.uploadId).completedBytes === 1,
    );
    await upload.close();
    await drained(upload);
    const job = upload.files.jobs.get(upload.scope, upload.uploadId);
    assert.equal(job.status, "cancelled");
    assert.equal(job.issue, null);
    await assert.rejects(fs.stat(path.join(f.home, "disconnect")), { code: "ENOENT" });
  } finally {
    await upload.close();
  }
});

test("owner cancellation still aborts an HTTP upload after internal input stop while its native write drains", async (t) => {
  const f = await applicationFixture(t),
    files = f.application.files,
    release = Promise.withResolvers();
  const native = files.publisher.native,
    run = native.run.bind(native),
    charge = files.store.uploads.charge.bind(files.store.uploads);
  let writing = false,
    failed = false,
    charged = 0;
  native.run = async (operation, args) => {
    if (operation === "write") {
      writing = true;
      await release.promise;
    }
    return run(operation, args);
  };
  files.store.uploads.charge = (...args) => {
    if (++charged === 2) {
      failed = true;
      throw Object.assign(new Error("fixture second report failure"), {
        code: "SQLITE_FULL",
      });
    }
    return charge(...args);
  };
  const upload = await pausedUpload(f, "owner-cancel", 3);
  try {
    upload.request.write("a");
    await until(() => writing);
    const controller = files.jobs.active.get(upload.uploadId).controller;
    upload.request.write("b");
    await until(() => failed);
    let transportClosed = false;
    upload.transport.then(() => {
      transportClosed = true;
    });
    await until(() => transportClosed);
    assert.equal(upload.request.writableEnded, false);
    assert.equal(controller.signal.aborted, false);
    assert.equal(files.jobs.transfers, 1);
    await files.publisher.barrier.snapshot(() => {});
    const cancelled = await f.request(`/api/files/jobs/${upload.uploadId}/cancel`, {
      method: "POST",
      headers: { "X-File-Scope": upload.scope.id },
      body: {},
    });
    assert.equal(cancelled.status, 200);
    assert.equal(controller.signal.aborted, true);
    assert.equal(files.jobs.transfers, 1);
    release.resolve();
    await drained(upload);
    const job = files.jobs.get(upload.scope, upload.uploadId);
    assert.equal(job.status, "cancelled");
    assert.equal(job.issue, null);
    await assert.rejects(fs.stat(path.join(f.home, "owner-cancel")), { code: "ENOENT" });
  } finally {
    release.resolve();
    await upload.close();
  }
});
