import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import { assistantWorkflowRoutes } from "../../server/http/routes/assistant-workflows.js";
import { ProjectDuplicates } from "../../server/application/project-duplicates.js";
import { listedProjects } from "../../web/lib/project-list.js";

// The owner's Work tab listed every stored row of a folder: the same name and path
// two or three times. The catalog now marks older rows like the projects hub does.
test("the Work tab catalog lists a folder with several rows once", async (t) => {
  const f = await workflowFixture(t);
  const services = f.workflows.s;
  services.projectDuplicates = new ProjectDuplicates({
    ...services,
    pipelineDefinitions: {
      getVerification: () => ({ steps: [] }),
      getRisk: () => ({ custom: false }),
    },
    pipelines: { store: { hasProject: () => false } },
  });
  // An older row of the same folder (a restart before the device-number fix).
  const older = "a".repeat(64);
  services.memory.db
    .prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
    .run(
      older,
      f.project.name,
      f.project.cwd,
      "directory",
      JSON.stringify(["directory", f.project.cwd, "1", "1"]),
      "2026-09-08T10:00:00Z",
    );
  const app = express();
  app.use(assistantWorkflowRoutes({ assistants: f.assistants }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const response = await fetch(
    `http://127.0.0.1:${server.address().port}/assistant-workspace-catalog`,
  );
  assert.equal(response.status, 200);
  const { projects } = await response.json();
  assert.equal(projects.length, 2, "both rows stay in the catalog");
  assert.deepEqual(
    projects.find((row) => row.id === older),
    {
      id: older,
      name: f.project.name,
      path: f.project.cwd,
      duplicateOf: f.project.id,
      pipelineWork: false,
    },
  );
  assert.deepEqual(
    listedProjects(projects).map((row) => row.id),
    [f.project.id],
    "the tab shows the folder once",
  );
  assert.deepEqual(
    listedProjects(projects, [older])
      .map((row) => row.id)
      .sort(),
    [f.project.id, older].sort(),
    "an older row the agent still holds stays listed so it can be revoked",
  );
});
