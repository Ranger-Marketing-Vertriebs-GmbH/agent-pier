import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";

const operation = (kind) => ({
  requestId: `${Date.now()}:${randomUUID()}`,
  kind,
  sources: [],
  target: null,
  name: null,
  options: {},
});
test("owner job routes exist and public operations reject unimplemented and internal kinds", async (t) => {
  const f = await applicationFixture(t);
  const scope = await (await f.request("/api/files/context")).json();
  const listed = await f.request("/api/files/jobs");
  assert.equal(listed.status, 200);
  assert.deepEqual(await listed.json(), { jobs: [], nextCursor: null });
  for (const kind of ["size", "copy", "fixture", "upload", "upload_group"]) {
    const response = await f.request("/api/files/operations", {
      method: "POST",
      headers: { "X-File-Scope": scope.scopeId },
      body: operation(kind),
    });
    assert.equal(response.status, 400, await response.clone().text());
    assert.equal((await response.json()).code, "FILE_INVALID_OPERATION");
  }
  const missing = await f.request("/api/files/jobs/missing");
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, "FILE_NOT_FOUND");
  const stale = await f.request("/api/files/jobs/missing/cancel", {
    method: "POST",
    headers: { "X-File-Scope": "stale" },
    body: {},
  });
  assert.equal(stale.status, 409);
});

test("job endpoints retain owner, login and origin isolation", async (t) => {
  const anonymous = await applicationFixture(t, { authenticateFixture: false });
  assert.equal((await anonymous.request("/api/files/jobs")).status, 401);
  const f = await applicationFixture(t);
  assert.equal(
    (
      await f.request("/api/files/jobs", {
        headers: { authorization: "Bearer fixture-machine-token" },
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/api/files/jobs", { origin: "https://foreign.example" })).status,
    403,
  );
});

test("registered public handlers support scoped jobs, entries, cancellation and stable failures", async (t) => {
  const { registerFileJobHandler } =
    await import("../../server/features/files/file-job-handlers.js");
  const f = await applicationFixture(t);
  const jobs = f.application.files.jobs;
  const scope = await f.application.files.context();
  const entered = Promise.withResolvers();
  registerFileJobHandler(
    f.application.files.handlers,
    "size",
    async ({ signal, jobId, report }) => {
      f.application.files.store.putEntry(jobId, {
        id: "visible",
        path: "visible.txt",
        text: "secret",
        privatePath: "private",
      });
      await report({ completedEntries: 1 });
      entered.resolve();
      await new Promise((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
    },
    {
      public: true,
      readOnly: true,
      validate: (op) => Object.keys(op.options).length === 0,
    },
  );
  const headers = { "X-File-Scope": scope.id };
  const op = operation("size");
  const response = await f.request("/api/files/operations", {
    method: "POST",
    headers,
    body: op,
  });
  assert.equal(response.status, 202, await response.clone().text());
  const job = await response.json();
  await entered.promise;
  const again = await f.request("/api/files/operations", {
    method: "POST",
    headers,
    body: op,
  });
  assert.equal((await again.json()).id, job.id);
  const entries = await f.request(`/api/files/jobs/${job.id}/entries`);
  assert.deepEqual(await entries.json(), {
    entries: [{ id: "visible", path: "visible.txt" }],
    nextCursor: null,
  });
  await f.application.sessions.save({
    id: "job-project",
    name: "fixture",
    tool: "shell",
    status: "exited",
    cwd: f.home,
    pipeline: { headless: true },
  });
  const project = "/api/sessions/job-project/files/explorer";
  const hidden = await f.request(`${project}/jobs/${job.id}`);
  assert.equal(hidden.status, 404);
  assert.deepEqual(await (await f.request(`${project}/jobs`)).json(), {
    jobs: [],
    nextCursor: null,
  });
  const invalid = await f.request("/api/files/operations", {
    method: "POST",
    headers,
    body: { ...operation("size"), options: { text: "secret" } },
  });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "FILE_INVALID_OPERATION");
  const cancelled = await f.request(`/api/files/jobs/${job.id}/cancel`, {
    method: "POST",
    headers,
    body: {},
  });
  assert.equal(cancelled.status, 200);
  await jobs.close();
});
