import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Operations } from "../../server/features/operations/operations.js";
import { operationsRoutes } from "../../server/http/routes/operations.js";
import { runOperations } from "../../scripts/operations.mjs";
import { setTimeout as delay } from "node:timers/promises";
import { AuditStore } from "../../server/features/audit/audit-store.js";
test("operations HTTP creates, downloads, inspects and restores an archive without persisting a passphrase", async (t) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "agentpier-ops-http-")),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  await fs.mkdir(dataDir, { mode: 0o700 });
  await fs.writeFile(path.join(dataDir, "accounts.json"), "[]");
  const audit = new AuditStore({ dataDir });
  t.after(() => audit.close());
  const operations = new Operations({
    audit,
    config: { dataDir, home: root },
    doctorOptions: {
      command: async () => ({ code: 1, stdout: "" }),
      ptyCheck: async () => true,
    },
  });
  const app = express();
  app.use(express.json());
  app.use("/api", operationsRoutes({ operations }));
  app.use((error, _req, res, _next) =>
    res.status(error.status || 500).json({ error: error.message }),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    await operations.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}/api/operations`;
  const post = (route, body) =>
    fetch(url + route, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const wait = async (id) => {
    for (let poll = 0; poll < 100; poll++) {
      const { job } = await (await fetch(`${url}/jobs/${id}`)).json();
      if (job.status !== "running") return job;
      await delay(10);
    }
    assert.fail("Operation did not complete.");
  };
  const { job } = await (
    await post("/backups", {
      withCredentials: true,
      passphrase: "private fixture passphrase",
    })
  ).json();
  const complete = await wait(job.id);
  assert.equal(complete.status, "succeeded");
  const download = await fetch(`${url}/backups/${complete.result.backup.id}/download`);
  assert.equal(
    download.headers.get("content-length"),
    String(complete.result.backup.bytes),
  );
  assert.match(download.headers.get("content-disposition"), /^attachment/);
  const content = Buffer.from(await download.arrayBuffer());
  assert.equal(
    (
      await fetch(`${url}/restore/upload`, {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: content,
      })
    ).status,
    400,
  );
  assert.equal((await fetch(`${url}/backups/${"0".repeat(8)}/download`)).status, 404);
  // A one-request upload needs its length; a chunked body without one is refused.
  const unsized = await fetch(`${url}/restore/upload`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Blob([content]).stream(),
    duplex: "half",
  });
  assert.equal(unsized.status, 411);
  assert.equal(
    (
      await fetch(`${url}/restore/upload`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: content,
      })
    ).status,
    201,
  );
  // Browsers upload in slices at exact offsets and complete the upload.
  const started = await post("/restore/uploads", { size: content.length });
  assert.equal(started.status, 201);
  const { uploadId } = await started.json();
  const slice = (offset, bytes) =>
    fetch(`${url}/restore/uploads/${uploadId}?offset=${offset}`, {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: bytes,
    });
  const third = Math.ceil(content.length / 3);
  assert.equal((await slice(0, content.subarray(0, third))).status, 200);
  // A slice at the wrong offset is refused and leaves the upload as it was.
  assert.equal((await slice(0, content.subarray(0, third))).status, 409);
  assert.equal((await slice(third + 1, content.subarray(third + 1))).status, 409);
  assert.equal(
    (await (await fetch(`${url}/restore/uploads/${uploadId}`)).json()).offset,
    third,
  );
  assert.equal(
    (await post(`/restore/uploads/${uploadId}/complete`, {})).status,
    409,
    "an incomplete upload cannot complete",
  );
  assert.equal((await slice(third, content.subarray(third, 2 * third))).status, 200);
  const last = await slice(2 * third, content.subarray(2 * third));
  assert.deepEqual(await last.json(), {
    uploadId,
    size: content.length,
    offset: content.length,
    chunkLimit: 64 * 1024 * 1024,
  });
  const completed = await post(`/restore/uploads/${uploadId}/complete`, {});
  assert.equal(completed.status, 201);
  const { archiveId } = await completed.json();
  assert.equal(archiveId, uploadId);
  const { inspection } = await (await post("/restore/inspect", { archiveId })).json();
  assert.equal(inspection.requiresPassphrase, true);
  const restoring = await (
    await post("/restore", {
      archiveId,
      targetDataDir: path.join(root, "target"),
      passphrase: "private fixture passphrase",
    })
  ).json();
  assert.equal((await wait(restoring.job.id)).status, "succeeded");
  const jobs = await fs.readdir(path.join(dataDir, "operations/jobs"));
  for (const file of jobs)
    assert.equal(
      (await fs.readFile(path.join(dataDir, "operations/jobs", file), "utf8")).includes(
        "private fixture passphrase",
      ),
      false,
    );
  const printed = [];
  await runOperations(
    ["inspect", "--archive", operations.backup.file(complete.result.backup.id)],
    { config: { dataDir }, log: (value) => printed.push(JSON.parse(value)) },
  );
  assert.equal(printed[0].credentialsIncluded, true);
  const invalid = await post("/restore", { archiveId, targetDataDir: dataDir });
  assert.equal(invalid.status, 202);
  const failed = await wait((await invalid.json()).job.id);
  assert.equal(failed.status, "failed");
  assert.equal(
    audit.export().filter((event) => event.action === "restore.failed").length,
    1,
  );
  assert.equal((await post("/backups", { output: "/outside" })).status, 400);
});
