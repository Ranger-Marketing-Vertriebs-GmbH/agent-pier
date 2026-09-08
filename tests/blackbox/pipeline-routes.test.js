import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

test("pipeline definitions expose versioned profile CRUD, snapshots and project verification through HTTP", async (t) => {
  const app = await applicationFixture(t);
  const response = await app.request("/api/pipeline-profiles");
  assert.equal(response.status, 200);
  const seed = (await response.json()).profiles.find(
    (profile) => profile.seedKey === "implementer",
  );
  const created = await app.request("/api/pipeline-profiles", {
    method: "POST",
    body: {
      ...seed,
      name: "Route fixture",
      config: {
        ...seed.config,
        accountId: "local-codex",
        cliTool: "codex",
        permissions: { mode: "never" },
      },
    },
  });
  assert.equal(created.status, 201);
  const { profile } = await created.json();
  assert.notEqual(profile.id, seed.id);
  const saved = await app.request("/api/pipelines", {
    method: "POST",
    body: {
      name: "Route pipeline",
      graph: {
        entry: "stage",
        nodes: [{ id: "stage", kind: "profile", profileId: profile.id }],
        edges: [],
      },
    },
  });
  assert.equal(saved.status, 201);
  const { pipeline } = await saved.json();
  assert.equal(
    (await app.request(`/api/pipeline-profiles/${profile.id}`, { method: "DELETE" }))
      .status,
    409,
  );
  const update = { ...profile, name: "Updated", expectedRevision: profile.revision };
  assert.equal(
    (
      await app.request(`/api/pipeline-profiles/${profile.id}`, {
        method: "PATCH",
        body: update,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request(`/api/pipeline-profiles/${profile.id}`, {
        method: "PATCH",
        body: update,
      })
    ).status,
    409,
  );
  const scope = await (
    await app.request("/api/memory/projects", { method: "POST", body: { cwd: app.home } })
  ).json();
  const steps = [
    { name: "Test", command: "node --version", timeoutMs: 1000, blocking: true },
  ];
  assert.equal(
    (
      await app.request(`/api/pipeline-verification/${scope.id}`, {
        method: "PUT",
        body: { steps },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await app.request("/api/pipeline-verification/missing", {
        method: "PUT",
        body: { steps },
      })
    ).status,
    404,
  );
  await app.restart();
  assert.deepEqual(
    (await (await app.request(`/api/pipeline-verification/${scope.id}`)).json()).steps,
    steps,
  );
  assert.equal(
    (await (await app.request(`/api/pipeline-profiles/${profile.id}`)).json()).profile
      .name,
    "Updated",
  );
  assert.equal(
    (await app.request(`/api/pipelines/${pipeline.id}`, { method: "DELETE" })).status,
    204,
  );
  assert.equal(
    (await app.request(`/api/pipeline-profiles/${profile.id}`, { method: "DELETE" }))
      .status,
    204,
  );
});

test("pipeline HTTP writes reject foreign origins and invalid graphs before starting a process", async (t) => {
  const app = await applicationFixture(t);
  assert.equal(
    (
      await app.request("/api/pipelines", {
        method: "POST",
        body: { name: "Unsafe", graph: {} },
        origin: "https://foreign.example",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await app.request("/api/pipelines", {
        method: "POST",
        body: { name: "Invalid", graph: {} },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await app.request("/api/pipeline-runs", {
        method: "POST",
        body: { pipelineId: "missing", cwd: app.home, task: "Test" },
      })
    ).status,
    404,
  );
  assert.equal((await app.request("/api/pipeline-runs?page=-1")).status, 400);
  assert.equal((await app.application.sessions.list()).length, 0);
});
