import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applicationFixture } from "../helpers/application.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { RunStore } from "../../server/features/pipelines/run-store.js";
import { listedProjects } from "../../web/lib/project-list.js";

const steps = [{ name: "Test", command: "npm test", timeoutMs: 60000, blocking: true }];

// Rows as releases before the rebind rule wrote them: the plain folder first, then
// its Git identity after `git init`, which collected the project's data.
async function legacyRow(memory, cwd, createdAt) {
  const scope = await projectScope(cwd);
  memory.db
    .prepare("INSERT OR IGNORE INTO projects VALUES (?,?,?,?,?,?)")
    .run(scope.id, path.basename(cwd), cwd, scope.kind, scope.identity, createdAt);
  return scope.id;
}
async function gitInitPair(app, name) {
  const memory = app.application.memory;
  const cwd = path.join(app.root, "work", name);
  fs.mkdirSync(cwd, { recursive: true });
  const plain = await legacyRow(memory, cwd, "2026-09-11T19:31:51.007Z");
  execFileSync("git", ["init", "-q", cwd]);
  const git = await legacyRow(memory, cwd, "2026-09-12T08:39:35.118Z");
  memory.write(git, { title: "Git note", content: "Knowledge of the Git identity" });
  return { cwd, plain, git };
}

test("pipeline lists show a folder with two stored rows once", async (t) => {
  const app = await applicationFixture(t);
  const lab = await gitInitPair(app, "electronic-lab");
  const raw = (await (await app.request("/api/memory/projects")).json()).projects;
  assert.equal(raw.filter((row) => row.cwd === lab.cwd).length, 2, "both rows stored");
  const described = (
    await (await app.request("/api/memory/projects?duplicates=1")).json()
  ).projects;
  assert.deepEqual(
    listedProjects(described)
      .filter((row) => row.cwd === lab.cwd)
      .map((row) => row.id),
    [lab.git],
  );
  assert.equal(
    described.find((row) => row.id === lab.plain).pipelineWork,
    false,
    "an older row without steps or runs",
  );
});

test("an older row with verification steps stays listed until its current row has its own", async (t) => {
  const app = await applicationFixture(t);
  const services = app.application;
  const lab = await gitInitPair(app, "verified");
  services.pipelineDefinitions.saveVerification(lab.plain, { steps });
  const listed = async () =>
    listedProjects(
      (await (await app.request("/api/memory/projects?duplicates=1")).json()).projects,
    )
      .filter((row) => row.cwd === lab.cwd)
      .map((row) => row.id)
      .sort();
  assert.deepEqual(await listed(), [lab.plain, lab.git].sort());
  services.pipelineDefinitions.saveVerification(lab.git, { steps });
  assert.deepEqual(await listed(), [lab.git]);
  assert.equal(services.pipelineDefinitions.getVerification(lab.plain).steps.length, 1);
});

test("the run store tells whether a project has runs", (t) => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "run-store-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new RunStore(dir);
  t.after(() => store.db.close());
  store.db
    .prepare("INSERT INTO runs VALUES (?,?,?)")
    .run("run-1", 1, JSON.stringify({ id: "run-1", projectId: "a".repeat(64) }));
  assert.equal(store.hasProject("a".repeat(64)), true);
  assert.equal(store.hasProject("b".repeat(64)), false);
});
