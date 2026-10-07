import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { applicationFixture } from "../helpers/application.js";
import { auditRows, projectHost, projectSession } from "../helpers/project-rebind.js";

const steps = [{ name: "Test", command: "npm test", timeoutMs: 60000, blocking: true }];

/** A project whose folder was replaced, so a second project row has the same path. */
async function replacedFolder(t, f) {
  const s = await projectSession(t, f);
  const older = s.fromId;
  const services = f.application;
  services.memory.write(older, { title: "Kept", content: "Older knowledge" });
  await projectHost(f, older);
  assert.equal((await s.publish()).isError, undefined);
  services.pipelineDefinitions.saveVerification(older, { steps });
  await fs.rename(s.cwd, `${s.cwd}-before`);
  await fs.mkdir(s.cwd);
  const response = await f.request("/api/memory/projects", {
    method: "POST",
    body: { cwd: s.cwd },
  });
  assert.equal(response.status, 201);
  const current = await response.json();
  assert.notEqual(current.id, older);
  return { s, older, current };
}
const projects = async (f) =>
  (await (await f.request("/api/memory/projects")).json()).projects;
const merge = (f, currentId, body) =>
  f.request(`/api/memory/projects/${currentId}/merge`, { method: "POST", body });

test("an older project of a replaced folder is described, previewed and merged on request", async (t) => {
  const f = await applicationFixture(t);
  const services = f.application;
  const { s, older, current } = await replacedFolder(t, f);
  const listed = await projects(f);
  const currentRow = listed.find((row) => row.id === current.id);
  assert.deepEqual(
    currentRow.olderDuplicates.map((row) => [row.id, row.entries]),
    [[older, 1]],
  );
  assert.equal(listed.find((row) => row.id === older).duplicateOf, current.id);
  // Nothing moves on its own.
  assert.equal(services.memory.list(older).total, 1);
  assert.equal(services.sshManagement.ownsProject(older), true);

  const preview = await (
    await f.request(`/api/memory/projects/${current.id}/merge?olderId=${older}`)
  ).json();
  assert.deepEqual(preview, {
    olderId: older,
    entries: 1,
    capabilities: 0,
    sshAccess: 2,
    artifacts: 1,
    verification: 1,
    sessions: 1,
  });

  const anonymous = await fetch(
    new URL(`/api/memory/projects/${current.id}/merge`, f.url),
    {
      method: "POST",
      headers: { origin: f.url, "content-type": "application/json" },
      body: JSON.stringify({ olderId: older, entries: 1 }),
    },
  );
  assert.equal(anonymous.status, 401);
  const stale = await merge(f, current.id, { olderId: older, entries: 2 });
  assert.equal(stale.status, 409);
  assert.equal(services.memory.list(older).total, 1, "a refused merge moves nothing");
  assert.equal((await merge(f, older, { olderId: current.id, entries: 0 })).status, 409);

  const merged = await merge(f, current.id, { olderId: older, entries: 1 });
  assert.equal(merged.status, 200);
  assert.equal((await merged.json()).id, current.id);
  assert.deepEqual(
    (await projects(f)).filter((row) => row.cwd === s.cwd).map((row) => row.id),
    [current.id],
  );
  assert.equal(services.memory.list(current.id).total, 1);
  assert.equal(services.memory.reboundTo(older), current.id);
  assert.equal(services.sshManagement.ownsProject(current.id), true);
  assert.equal(services.sshManagement.ownsProject(older), false);
  assert.equal(services.artifacts.ownsProject(current.id), true);
  assert.equal(services.pipelineDefinitions.hasVerification(current.id), true);
  assert.equal(services.pipelineDefinitions.hasVerification(older), false);
  const record = await s.record();
  assert.equal(record.sshTools.project.projectId, current.id);
  assert.deepEqual(
    auditRows(f, "project.updated").map((row) => [row.projectId, row.source]),
    [[current.id, "user"]],
  );
  // A repeated request finds the merge done and changes nothing.
  const again = await merge(f, current.id, { olderId: older, entries: 1 });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).id, current.id);
  assert.equal(auditRows(f, "project.updated").length, 1);
});

test("a merge that would mix SSH access of both projects is refused", async (t) => {
  const f = await applicationFixture(t);
  const { older, current } = await replacedFolder(t, f);
  await projectHost(f, current.id);
  const response = await merge(f, current.id, { olderId: older, entries: 1 });
  assert.equal(response.status, 409);
  assert.equal(f.application.memory.list(older).total, 1);
  assert.equal(f.application.memory.reboundTo(older), null);
});
