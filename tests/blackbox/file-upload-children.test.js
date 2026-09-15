import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { uploadRequest } from "../helpers/file-uploads.js";
import { Readable } from "node:stream";

test("current upload children expose scoped public jobs through bounded opaque pages", async (t) => {
  const f = await applicationFixture(t);
  const files = f.application.files;
  const scope = await files.context();
  const { groupId } = await files.uploads.createGroup(scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  const entries = Array.from({ length: 202 }, (_, n) => ({
    id: `entry-${n}`,
    relativePath: `${n}.txt`,
    type: "file",
    bytes: 0,
  }));
  await files.uploads.appendGroup(scope, groupId, { batchId: "batch", entries });
  await files.uploads.commitGroup(scope, groupId);
  for (const entry of entries) {
    await files.uploads.create(scope, {
      requestId: uploadRequest(),
      path: f.home,
      name: entry.relativePath,
      bytes: 0,
      groupId,
      entryId: entry.id,
    });
  }
  const base = `/api/files/jobs/${groupId}/upload-children`;
  const response = await f.request(base);
  assert.equal(response.status, 200);
  const first = await response.json();
  assert.equal(first.children.length, 200);
  assert.ok(first.nextCursor);
  const second = await (
    await f.request(`${base}?cursor=${encodeURIComponent(first.nextCursor)}`)
  ).json();
  assert.equal(second.children.length, 2);
  assert.equal(second.nextCursor, null);
  assert.equal(second.children[1].entryId, "entry-201");
  for (const child of [...first.children, ...second.children]) {
    assert.deepEqual(Object.keys(child).sort(), ["entryId", "job"]);
    assert.equal(child.job.scopeId, scope.id);
    assert.equal(child.job.kind, "upload");
    for (const forbidden of [
      "currentJobId",
      "operation",
      "parentJobId",
      "entryId",
      "inode",
      "hash",
    ])
      assert.equal(Object.hasOwn(child.job, forbidden), false);
  }
  const entryPage = files.jobs.entries(scope, groupId);
  assert.equal(
    (await f.request(`${base}?cursor=${encodeURIComponent(entryPage.nextCursor)}`))
      .status,
    400,
  );
  await files.jobs.cancel(scope, groupId);
});

test("current-child projection preserves pruned nulls and rejects mismatched scope, parent, entry and type", async (t) => {
  const f = await applicationFixture(t),
    files = f.application.files;
  const scope = await files.context();
  const { groupId } = await files.uploads.createGroup(scope, {
    requestId: uploadRequest(),
    path: f.home,
  });
  const entries = ["done", "live", "unused"].map((id) => ({
    id,
    relativePath: id,
    type: "file",
    bytes: 1,
  }));
  await files.uploads.appendGroup(scope, groupId, { batchId: "batch", entries });
  await files.uploads.commitGroup(scope, groupId);
  const create = (entryId) =>
    files.uploads.create(scope, {
      requestId: uploadRequest(),
      path: f.home,
      name: entryId,
      bytes: 1,
      groupId,
      entryId,
    });
  const done = await create("done");
  await files.uploads.receive(scope, done.uploadId, Readable.from([Buffer.from("a")]));
  const live = await create("live");
  files.store.prune(Date.now() + 8 * 86400000);
  const suffix = `/api/files/jobs/${groupId}/upload-children`;
  const current = await (await f.request(suffix)).json();
  assert.deepEqual(
    current.children.map((row) => [row.entryId, row.job?.id ?? null]),
    [
      ["done", null],
      ["live", live.uploadId],
    ],
  );
  const original = files.store.db
    .prepare("SELECT * FROM jobs WHERE id=?")
    .get(live.uploadId);
  for (const [column, value] of [
    ["scope_id", "another-scope"],
    ["parent_job_id", null],
    ["entry_id", "different-entry"],
    ["kind", "create_directory"],
  ]) {
    files.store.db
      .prepare(`UPDATE jobs SET ${column}=? WHERE id=?`)
      .run(value, live.uploadId);
    const page = await (await f.request(suffix)).json();
    assert.equal(page.children.find((row) => row.entryId === "live").job, null);
    files.store.db
      .prepare(`UPDATE jobs SET ${column}=? WHERE id=?`)
      .run(original[column], live.uploadId);
  }
  await files.jobs.cancel(scope, groupId);
  assert.equal(files.jobs.get(scope, live.uploadId).status, "cancelled");
});

test("child lookup preserves authentication and trusted project scope without granting mutation authority", async (t) => {
  const f = await applicationFixture(t),
    files = f.application.files;
  await f.application.sessions.save({
    id: "upload-view",
    name: "Upload view",
    tool: "shell",
    status: "exited",
    cwd: f.home,
  });
  const project = await files.context("upload-view"),
    global = await files.context();
  const { groupId } = await files.uploads.createGroup(project, {
    requestId: uploadRequest(),
    path: "",
  });
  const base = `/api/sessions/upload-view/files/explorer/jobs/${groupId}/upload-children`;
  assert.equal((await f.request(base)).status, 200);
  assert.equal(
    (await f.request(`/api/files/jobs/${groupId}/upload-children`)).status,
    404,
  );
  const other = await files.uploads.createGroup(global, {
    requestId: uploadRequest(),
    path: f.home,
  });
  assert.equal((await f.request(base.replace(groupId, other.groupId))).status, 404);
  for (const [headers, expected] of [
    [{ cookie: "" }, 401],
    [{ authorization: "Bearer fake" }, 403],
    [{ origin: "https://wrong.example" }, 403],
  ]) {
    const response = await fetch(f.url + base, {
      headers: { cookie: f.cookie, origin: f.url, ...headers },
    });
    assert.equal(response.status, expected);
  }
  const cursor = Buffer.from(
    JSON.stringify({
      scope: project.id,
      collection: `upload-children:${other.groupId}`,
      after: 1,
    }),
  ).toString("base64url");
  assert.equal((await f.request(`${base}?cursor=${cursor}`)).status, 400);
});
