import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { applicationFixture } from "../helpers/application.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { cleanUpProjects } from "../../server/application/project-cleanup.js";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
const steps = [{ name: "Test", command: "npm test", timeoutMs: 60000, blocking: true }];
// [kind, folder or Git common directory, device, inode] under a renumbered device.
function renumbered(kind, place) {
  const stat = fs.statSync(place, { bigint: true });
  const parts = [kind, place, String(stat.dev + 2n), String(stat.ino)];
  const id = createHash("sha256").update(JSON.stringify(parts)).digest("hex");
  return { id, identity: JSON.stringify(parts) };
}

test("the worktree cleanup relocates a row registered under an earlier device number", async (t) => {
  const app = await applicationFixture(t);
  const services = app.application;
  const { memory } = services;
  const root = path.join(app.root, "work", "app");
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q", root]);
  fs.writeFileSync(path.join(root, "README.md"), "x\n");
  execFileSync("git", ["-C", root, "add", "."], { env });
  execFileSync("git", ["-C", root, "commit", "-qm", "init"], { env });
  const run = path.join(root, ".agentpier-worktrees", "5e1f0c2a");
  execFileSync("git", ["-C", root, "worktree", "add", "-q", "--detach", run]);
  // A run worktree registered the project first, before the volume was renumbered.
  const { id, identity } = renumbered("git", fs.realpathSync(path.join(root, ".git")));
  memory.db
    .prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
    .run(id, "5e1f0c2a", run, "git", identity, "2026-09-01T00:00:00Z");
  memory.write(id, { title: "Kept", content: "Registered from a run worktree" });
  assert.equal((await projectScope(root)).id, id);
  memory.db.prepare("DELETE FROM migrations").run();
  const summary = await cleanUpProjects(services);
  assert.equal(summary.relocated, 1);
  assert.equal(memory.project(id).cwd, root);
  assert.equal(memory.project(id).name, "app");
});

test("a recorded git-init move resumes after the volume was renumbered", async (t) => {
  const app = await applicationFixture(t);
  const services = app.application;
  const { memory } = services;
  const lab = path.join(app.root, "work", "lab");
  fs.mkdirSync(lab, { recursive: true });
  // The plain-folder project, registered under an earlier device number: its row
  // moved to the Git project already, its verification steps did not.
  const plain = renumbered("directory", fs.realpathSync(lab)).id;
  execFileSync("git", ["init", "-q", lab]);
  const git = (await memory.register(lab)).id;
  memory.db
    .prepare("INSERT INTO project_rebinds VALUES (?,?,?)")
    .run(plain, git, "2026-10-01T00:00:00Z");
  services.pipelineDefinitions.saveVerification(plain, { steps });
  assert.equal(services.projectRebind.remnants(plain), true);
  memory.db.prepare("DELETE FROM migrations").run();
  const summary = await cleanUpProjects(services);
  assert.equal(summary.complete, true);
  assert.equal(services.pipelineDefinitions.hasVerification(plain), false);
  assert.equal(services.pipelineDefinitions.hasVerification(git), true);
  assert.equal(services.projectRebind.remnants(plain), false);
});
