import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture, fixtureFetch } from "../helpers/application.js";
import { uploadRequest } from "../helpers/file-uploads.js";

test("raw HTTP bytes bypass JSON64KiB and direct downloads preserve bytes and safe headers", async (t) => {
  const f = await applicationFixture(t);
  const { scopeId } = await (await f.request("/api/files/context")).json();
  const bytes = Buffer.alloc(131072, 123),
    name = 'quote"é.bin';
  const created = await f.request("/api/files/uploads", {
    method: "POST",
    headers: { "X-File-Scope": scopeId },
    body: {
      scopeId,
      requestId: uploadRequest(),
      path: f.home,
      name,
      bytes: bytes.length,
    },
  });
  assert.equal(created.status, 201, await created.clone().text());
  const { uploadId } = await created.json();
  const result = await fixtureFetch(`${f.url}/api/files/uploads/${uploadId}/content`, {
    method: "PUT",
    headers: {
      origin: f.url,
      "X-File-Scope": scopeId,
      "content-type": "application/octet-stream",
    },
    body: bytes,
  });
  assert.equal(result.status, 200, await result.clone().text());
  assert.equal((await result.json()).status, "completed");
  assert.deepEqual(await fs.readFile(path.join(f.home, name)), bytes);
  const download = await f.request(
    `/api/files/download?path=${encodeURIComponent(path.join(f.home, name))}`,
  );
  assert.equal(download.status, 200);
  assert.equal(download.headers.get("cache-control"), "no-store");
  assert.equal(download.headers.get("x-content-type-options"), "nosniff");
  assert.match(download.headers.get("content-disposition"), /^attachment; /);
  assert.match(download.headers.get("content-disposition"), /filename\*=UTF-8''/);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
});

test("normal and raw transfer routes reject wrong origin, bearer and missing login", async (t) => {
  const f = await applicationFixture(t);
  const { scopeId } = await (await f.request("/api/files/context")).json();
  for (const [suffix, method] of [
    ["/uploads", "POST"],
    ["/uploads/unknown/content", "PUT"],
    ["/download", "GET"],
  ]) {
    for (const [headers, expected] of [
      [{ origin: "https://invalid.example" }, 403],
      [{ authorization: "Bearer fake" }, 403],
      [{ cookie: "" }, 401],
    ]) {
      const response = await fetch(`${f.url}/api/files${suffix}`, {
        method,
        headers: { cookie: f.cookie, origin: f.url, "X-File-Scope": scopeId, ...headers },
      });
      assert.equal(response.status, expected);
    }
  }
  const invalid = await f.request("/api/files/uploads", {
    method: "POST",
    body: { padding: "x".repeat(65536) },
  });
  assert.equal(invalid.status, 413);
});

test("project raw uploads enforce current scope and headless download remains readonly", async (t) => {
  const f = await applicationFixture(t);
  await f.application.sessions.save({
    id: "transfer-project",
    name: "transfer-project",
    tool: "shell",
    status: "exited",
    cwd: f.home,
    pipeline: { headless: true },
  });
  const base = "/api/sessions/transfer-project/files/explorer";
  const { scopeId } = await (await f.request(`${base}/context`)).json();
  await fs.writeFile(path.join(f.home, "read"), "headless bytes");
  const download = await f.request(`${base}/download?path=read`);
  assert.equal(download.status, 200);
  assert.equal(await download.text(), "headless bytes");
  const created = await f.request(`${base}/uploads`, {
    method: "POST",
    headers: { "X-File-Scope": scopeId },
    body: { requestId: uploadRequest(), path: "", name: "no-write", bytes: 3 },
  });
  assert.equal(created.status, 403);
  const raw = await fixtureFetch(`${f.url}${base}/uploads/unknown/content`, {
    method: "PUT",
    headers: {
      origin: f.url,
      "X-File-Scope": scopeId,
      "content-type": "application/octet-stream",
    },
    body: "abc",
  });
  assert.equal(raw.status, 403);
  assert.equal(
    (await f.request(`${base}/download?path=${encodeURIComponent("../outside")}`)).status,
    403,
  );
  const stale = await fixtureFetch(`${f.url}/api/files/uploads/unknown/content`, {
    method: "PUT",
    headers: {
      origin: f.url,
      "X-File-Scope": scopeId,
      "content-type": "application/octet-stream",
    },
    body: "abc",
  });
  assert.equal(stale.status, 409);
});

test("expired owner login rejects metadata, raw content and direct download before access", async (t) => {
  const f = await applicationFixture(t);
  f.application.login.now = () => Date.now() + 366 * 86400000;
  for (const [suffix, method] of [
    ["/uploads", "POST"],
    ["/uploads/unknown/content", "PUT"],
    ["/download", "GET"],
  ]) {
    const response = await f.request(`/api/files${suffix}`, { method });
    assert.equal(response.status, 401);
  }
});

test("actual HTTP disconnect cancels a partially received upload and frees its transfer slot", async (t) => {
  const f = await applicationFixture(t),
    files = f.application.files;
  const scope = await files.context();
  const created = await f.request("/api/files/uploads", {
    method: "POST",
    headers: { "X-File-Scope": scope.id },
    body: { requestId: uploadRequest(), path: f.home, name: "disconnect", bytes: 262144 },
  });
  const { uploadId } = await created.json();
  const body = new PassThrough(),
    controller = new AbortController();
  const response = fixtureFetch(`${f.url}/api/files/uploads/${uploadId}/content`, {
    method: "PUT",
    headers: {
      origin: f.url,
      "X-File-Scope": scope.id,
      "content-type": "application/octet-stream",
    },
    body,
    duplex: "half",
    signal: controller.signal,
  });
  const aborted = assert.rejects(response, { name: "AbortError" });
  body.write(Buffer.alloc(131072, 33));
  for (let n = 0; n < 500 && files.jobs.get(scope, uploadId).completedBytes === 0; n++)
    await delay(10);
  assert.ok(files.jobs.get(scope, uploadId).completedBytes > 0);
  await files.publisher.barrier.snapshot(() => {});
  controller.abort();
  body.destroy();
  await aborted;
  for (let n = 0; n < 500 && files.jobs.transfers; n++) await delay(10);
  assert.equal(files.jobs.transfers, 0);
  assert.equal(files.jobs.get(scope, uploadId).status, "cancelled");
  await assert.rejects(fs.stat(path.join(f.home, "disconnect")), { code: "ENOENT" });
});
