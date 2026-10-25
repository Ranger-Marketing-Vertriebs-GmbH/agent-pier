import test from "node:test";
import assert from "node:assert/strict";
import {
  launchProject,
  launchSecretSelection,
} from "../../web/features/secrets/launch-secrets.js";

const projects = [
  { id: "app", cwd: "/work/app" },
  { id: "server", cwd: "/work/app/server/" },
  { id: "docs", cwd: "/work/docs" },
];

test("the launch project is the innermost project folder holding the directory", () => {
  assert.equal(launchProject(projects, "/work/app")?.id, "app");
  assert.equal(launchProject(projects, "/work/app/web/")?.id, "app");
  assert.equal(launchProject(projects, "/work/app/server/lib")?.id, "server");
  assert.equal(launchProject(projects, "/work/application"), null);
  assert.equal(launchProject(projects, ""), null);
  assert.equal(launchProject([], "/work/app"), null);
});

test("a selection keeps only existing secrets the project does not bring", () => {
  const secrets = [
    { id: "own", projectId: "app" },
    { id: "global", projectId: null },
  ];
  const selected = ["own", "global"];
  assert.deepEqual(launchSecretSelection(selected, secrets, "app"), ["global"]);
  assert.equal(launchSecretSelection(["global"], secrets, "app").length, 1);
  assert.deepEqual(launchSecretSelection(["gone", "own"], secrets, null), ["own"]);
  // Nothing to drop returns the same array, so no state update loops.
  assert.equal(launchSecretSelection(selected, secrets, null), selected);
});
