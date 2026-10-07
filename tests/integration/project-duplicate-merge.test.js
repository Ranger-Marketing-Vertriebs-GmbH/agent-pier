import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { applicationFixture } from "../helpers/application.js";
import { auditRows, projectHost, projectSession } from "../helpers/project-rebind.js";

const steps = [{ name: "Test", command: "npm test", timeoutMs: 60000, blocking: true }];

/** Replaces the folder, so a new current project row shares the older row's path. */
async function replace(f, cwd) {
  await fs.rename(cwd, `${cwd}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(cwd);
  const response = await f.request("/api/memory/projects", {
    method: "POST",
    body: { cwd },
  });
  assert.equal(response.status, 201);
  return response.json();
}
/** A project with knowledge, SSH access, an artifact and verification, then replaced. */
async function replacedFolder(t, f) {
  const s = await projectSession(t, f);
  const older = s.fromId;
  const services = f.application;
  services.memory.write(older, { title: "Kept", content: "Older knowledge" });
  await projectHost(f, older);
  assert.equal((await s.publish()).isError, undefined);
  services.pipelineDefinitions.saveVerification(older, { steps });
  const current = await replace(f, s.cwd);
  assert.notEqual(current.id, older);
  return { s, older, current };
}
const projects = async (f, query = "?duplicates=1") =>
  (await (await f.request(`/api/memory/projects${query}`)).json()).projects;
const preview = async (f, currentId, olderId) =>
  f.request(`/api/memory/projects/${currentId}/merge?olderId=${olderId}`);
const merge = (f, currentId, body, options = {}) =>
  f.request(`/api/memory/projects/${currentId}/merge`, {
    method: "POST",
    body,
    ...options,
  });
const fingerprint = async (f, currentId, olderId) =>
  (await (await preview(f, currentId, olderId)).json()).fingerprint;

test("an older project of a replaced folder is described, previewed and merged on request", async (t) => {
  const f = await applicationFixture(t);
  const services = f.application;
  const { s, older, current } = await replacedFolder(t, f);
  assert.ok(
    (await projects(f, "")).every((row) => !row.duplicateOf),
    "opt-in only",
  );
  const listed = await projects(f);
  const currentRow = listed.find((row) => row.id === current.id);
  assert.deepEqual(
    currentRow.olderDuplicates.map((row) => [row.id, row.entries]),
    [[older, 1]],
  );
  assert.equal(listed.find((row) => row.id === older).duplicateOf, current.id);
  assert.equal(services.memory.list(older).total, 1, "nothing moves on its own");

  const response = await preview(f, current.id, older);
  const { fingerprint: seen, ...counts } = await response.json();
  assert.match(seen, /^[a-f0-9]{64}$/);
  assert.deepEqual(counts, {
    olderId: older,
    entries: 1,
    archivedEntries: 0,
    capabilities: 0,
    sshAccess: 2,
    artifacts: 1,
    verification: 1,
    sessions: 1,
  });

  const anonymous = (method) =>
    fetch(new URL(`/api/memory/projects/${current.id}/merge?olderId=${older}`, f.url), {
      method,
      headers: { origin: f.url, "content-type": "application/json" },
      ...(method === "POST"
        ? { body: JSON.stringify({ olderId: older, fingerprint: seen }) }
        : {}),
    });
  assert.equal((await anonymous("GET")).status, 401);
  assert.equal((await anonymous("POST")).status, 401);
  const foreign = await merge(
    f,
    current.id,
    { olderId: older, fingerprint: seen },
    { origin: "https://foreign.example" },
  );
  assert.equal(foreign.status, 403);
  // Anything that changed after the preview, here one more artifact-free entry.
  services.memory.write(older, { title: "Later", content: "Added after the preview" });
  assert.equal(
    (await merge(f, current.id, { olderId: older, fingerprint: seen })).status,
    409,
  );
  const other = path.join(f.project, "elsewhere");
  await fs.mkdir(other);
  const unrelated = await (
    await f.request("/api/memory/projects", { method: "POST", body: { cwd: other } })
  ).json();
  for (const [currentId, olderId] of [
    [older, current.id],
    [current.id, unrelated.id],
    [current.id, "0".repeat(64)],
  ]) {
    assert.equal((await preview(f, currentId, olderId)).status, 409);
    assert.equal((await merge(f, currentId, { olderId, fingerprint: seen })).status, 409);
  }
  assert.equal(services.memory.list(older).total, 2, "a refused merge moves nothing");

  const fresh = await fingerprint(f, current.id, older);
  const merged = await merge(f, current.id, { olderId: older, fingerprint: fresh });
  assert.equal(merged.status, 200);
  assert.equal((await merged.json()).id, current.id);
  assert.deepEqual(
    (await projects(f)).filter((row) => row.cwd === s.cwd).map((row) => row.id),
    [current.id],
  );
  assert.equal(services.memory.list(current.id).total, 2);
  assert.equal(services.memory.reboundTo(older), current.id);
  assert.equal(services.memory.pendingMerge(older), null);
  assert.equal(services.sshManagement.ownsProject(current.id), true);
  assert.equal(services.sshManagement.ownsProject(older), false);
  assert.equal(services.artifacts.ownsProject(current.id), true);
  assert.equal(services.pipelineDefinitions.hasVerification(current.id), true);
  assert.equal(services.pipelineDefinitions.hasVerification(older), false);
  assert.equal((await s.record()).sshTools.project.projectId, current.id);
  const audited = auditRows(f, "project.updated");
  assert.deepEqual(
    audited
      .filter((row) => row.outcome === "success")
      .map((row) => [row.projectId, row.source, row.details?.fromProjectId]),
    [[current.id, "user", older]],
  );
  assert.ok(
    audited.some((row) => row.outcome === "failure"),
    "refusals are audited",
  );
  // A repeated request finds the merge done and changes nothing.
  const count = audited.length;
  const again = await merge(f, current.id, { olderId: older, fingerprint: fresh });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).id, current.id);
  assert.equal(auditRows(f, "project.updated").length, count);
});

test("a merge that would mix SSH access of both projects is refused", async (t) => {
  const f = await applicationFixture(t);
  const { older, current } = await replacedFolder(t, f);
  await projectHost(f, current.id);
  const seen = await fingerprint(f, current.id, older);
  const response = await merge(f, current.id, { olderId: older, fingerprint: seen });
  assert.equal(response.status, 409);
  assert.equal(f.application.memory.list(older).total, 1);
  assert.equal(f.application.memory.reboundTo(older), null);
});

test("two concurrent merges of SSH-holding rows into one project cannot both succeed", async (t) => {
  const f = await applicationFixture(t);
  const { s, older: first } = await replacedFolder(t, f);
  const second = (await projects(f)).find(
    (row) => row.cwd === s.cwd && row.id !== first,
  ).id;
  await projectHost(f, second);
  const current = await replace(f, s.cwd);
  const [a, b] = await Promise.all([
    fingerprint(f, current.id, first),
    fingerprint(f, current.id, second),
  ]);
  const responses = await Promise.all([
    merge(f, current.id, { olderId: first, fingerprint: a }),
    merge(f, current.id, { olderId: second, fingerprint: b }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const ssh = f.application.sshManagement;
  assert.equal([first, second].filter((id) => ssh.ownsProject(id)).length, 1);
});

test("a merge interrupted after the memory move finishes on the next start", async (t) => {
  const f = await applicationFixture(t);
  const { older, current } = await replacedFolder(t, f);
  const seen = await fingerprint(f, current.id, older);
  const artifacts = f.application.artifacts;
  const original = artifacts.moveProject;
  artifacts.moveProject = async () => {
    artifacts.moveProject = original;
    throw Object.assign(new Error("Injected failure"), { code: "EIO" });
  };
  const failed = await merge(f, current.id, { olderId: older, fingerprint: seen });
  assert.ok(failed.status >= 400, `the failure is reported (${failed.status})`);
  assert.equal(f.application.memory.hasProject(older), false);
  assert.equal(f.application.memory.pendingMerge(older), current.id);
  assert.equal(f.application.artifacts.ownsProject(older), true);
  await f.restart();
  const services = f.application;
  assert.equal(services.memory.pendingMerge(older), null);
  assert.equal(services.artifacts.ownsProject(older), false);
  assert.equal(services.artifacts.ownsProject(current.id), true);
  assert.equal(services.pipelineDefinitions.hasVerification(current.id), true);
  // The finished merge stays finished.
  const again = await merge(f, current.id, { olderId: older, fingerprint: seen });
  assert.equal(again.status, 200);
});
