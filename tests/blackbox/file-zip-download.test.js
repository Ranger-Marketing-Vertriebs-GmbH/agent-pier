import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { uploadRequest } from "../helpers/file-uploads.js";
import { waitForFileJob } from "../helpers/file-explorer.js";
import { registerFileJobHandler } from "../../server/features/files/file-job-handlers.js";

async function startArchiveJob(f, { output }) {
  const source = path.join(f.home, "source.txt");
  await fs.writeFile(source, "archive source");
  const { scopeId } = await (await f.request("/api/files/context")).json();
  const response = await f.request("/api/files/operations", {
    method: "POST",
    headers: { "X-File-Scope": scopeId },
    body: {
      requestId: uploadRequest(),
      kind: "archive",
      sources: [source],
      target: null,
      name: null,
      options: { output },
    },
  });
  assert.equal(response.status, 202, await response.clone().text());
  return response.json();
}
test("a ZIP download is unavailable until its artifact is complete", async (t) => {
  const f = await applicationFixture(t);
  const gate = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const original = f.application.files.handlers.get("archive");
  registerFileJobHandler(
    f.application.files.handlers,
    "archive",
    async (context) => {
      entered.resolve();
      await gate.promise;
      await original?.(context);
    },
    { public: true, transfer: true, validate: () => true },
  );
  t.after(() => gate.resolve());
  const job = await startArchiveJob(f, { output: "download" });
  await entered.promise;
  try {
    const pending = await f.request(`/api/files/jobs/${job.id}/download`);
    assert.equal(pending.status, 409);
  } finally {
    gate.resolve();
  }
  assert.equal((await waitForFileJob(f, job.id)).status, "completed");
  const ready = await f.request(`/api/files/jobs/${job.id}/download`);
  assert.equal(ready.status, 200);
  assert.match(ready.headers.get("content-disposition"), /^attachment;/);
  assert.equal(ready.headers.get("cache-control"), "no-store");
  assert.equal(ready.headers.get("x-content-type-options"), "nosniff");
});

test("project headless archive, versioned consent and artifact HTTP retain owner/scope authority", async (t) => {
  const f = await applicationFixture(t);
  const session = {
    id: "archive-project",
    name: "archive-project",
    tool: "shell",
    status: "exited",
    createdAt: new Date().toISOString(),
    cwd: f.home,
    pipeline: { headless: true },
  };
  await f.application.sessions.save(session);
  await fs.writeFile(path.join(f.home, "read"), "headless archive");
  await fs.symlink("read", path.join(f.home, "link"));
  const base = "/api/sessions/archive-project/files/explorer";
  const { scopeId } = await (await f.request(`${base}/context`)).json();
  const operation = {
    requestId: uploadRequest(),
    kind: "archive",
    sources: ["."],
    target: null,
    name: 'quote"é.zip',
    options: { output: "download" },
  };
  const headers = { "X-File-Scope": scopeId };
  const created = await f.request(`${base}/operations`, {
    method: "POST",
    headers,
    body: operation,
  });
  assert.equal(created.status, 202, await created.clone().text());
  const job = await created.json();
  const waiting = await waitForFileJob(f, job.id, {
    base,
    states: ["waiting_for_conflict"],
  });
  const manifest = await (await f.request(`${base}/jobs/${job.id}/entries`)).json();
  assert.ok(
    manifest.entries.some(
      (e) => e.type === "symlink" && e.issue.code === "FILE_ARCHIVE_LINKS",
    ),
  );
  assert.equal(JSON.stringify(manifest).includes(f.dataDir), false);
  const resolved = await f.request(`${base}/jobs/${job.id}/resolve`, {
    method: "POST",
    headers,
    body: {
      conflictId: waiting.conflict.id,
      decision: "skip_links",
      applyToRemaining: false,
    },
  });
  assert.equal(resolved.status, 200, await resolved.clone().text());
  assert.equal((await waitForFileJob(f, job.id, { base })).status, "completed");
  const ready = await f.request(
    `${base}/jobs/${job.id}/download?path=/ignored/private/path`,
  );
  assert.equal(ready.status, 200);
  assert.match(ready.headers.get("content-disposition"), /filename\*=UTF-8''/);
  assert.equal((await f.request(`/api/files/jobs/${job.id}/download`)).status, 404);
  await f.application.sessions.save({ ...session, id: "other-project" });
  assert.equal(
    (
      await f.request(
        `/api/sessions/other-project/files/explorer/jobs/${job.id}/download`,
      )
    ).status,
    404,
  );
  for (const [extra, expected] of [
    [{ origin: "https://invalid.example" }, 403],
    [{ authorization: "Bearer fake" }, 403],
    [{ cookie: "" }, 401],
  ]) {
    const response = await f.request(`${base}/jobs/${job.id}/download`, {
      headers: extra,
    });
    assert.equal(response.status, expected);
  }
  const file = await f.request(`${base}/operations`, {
    method: "POST",
    headers,
    body: {
      ...operation,
      requestId: uploadRequest(),
      target: "",
      options: { output: "file" },
    },
  });
  assert.equal(file.status, 403);
  for (const patch of [
    { target: f.dataDir },
    { name: "\ud800" },
    { options: { output: "download", artifactPath: f.dataDir } },
    { options: { output: "file", readOnly: true } },
  ]) {
    const invalid = await f.request(`${base}/operations`, {
      method: "POST",
      headers,
      body: { ...operation, requestId: uploadRequest(), ...patch },
    });
    assert.equal(invalid.status, 400);
  }
  const outside = await f.request(`${base}/operations`, {
    method: "POST",
    headers,
    body: { ...operation, requestId: uploadRequest(), sources: [f.dataDir] },
  });
  assert.equal(outside.status, 202);
  assert.equal(
    (await waitForFileJob(f, (await outside.json()).id, { base })).issue.code,
    "FILE_OUTSIDE_SCOPE",
  );
});
