import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { mainWorkTree } from "../../server/features/memory/project-folders.js";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { createSshProjectBinding } from "../../server/features/ssh/ssh-project-scope.js";
import { sshManagementFixture } from "../helpers/ssh-management.js";

// AGENTPIER-444: a project first seen from one of its worktrees (an agent's coding
// session in `<project>/.agentpier-worktrees/agent-<id>`, or any linked Git
// worktree) is named and placed by its main work tree, never by the worktree.
function repository(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "worktree-root-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const main = path.join(root, "beta");
  fs.mkdirSync(main);
  const git = (...args) => execFileSync("git", ["-C", main, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "fixture",
  );
  const fenced = path.join(main, ".agentpier-worktrees", "agent-1234");
  git("worktree", "add", "-q", "-b", "agent-1234", fenced);
  const linked = path.join(root, "beta-linked");
  git("worktree", "add", "-q", "-b", "linked", linked);
  return { root, main, fenced, linked };
}

test("a worktree's project scope is its main work tree's", async (t) => {
  const r = repository(t);
  const main = await projectScope(r.main);
  for (const folder of [r.fenced, r.linked]) {
    const scope = await projectScope(folder);
    assert.equal(scope.id, main.id);
    assert.equal(scope.name, "beta");
    assert.equal(scope.cwd, r.main);
  }
  assert.equal(mainWorkTree(r.fenced), r.main);
  assert.equal(mainWorkTree(r.linked), r.main);
  assert.equal(mainWorkTree(r.main), null);
  assert.equal(mainWorkTree(path.join(r.root, "missing")), null);
});

test("an SSH project binding from a worktree names the project root", async (t) => {
  const r = repository(t);
  const binding = await createSshProjectBinding(r.fenced);
  assert.equal(binding.name, "beta");
  assert.equal(binding.cwd, r.main);
  // The launch folder stays the worktree the session runs in.
  assert.equal(binding.launch.path, r.fenced);
});

test("project memory registers a worktree as its project root", async (t) => {
  const r = repository(t);
  const memory = new ProjectMemory({ dataDir: path.join(r.root, "data"), home: r.root });
  t.after(() => memory.close());
  const project = await memory.register(r.linked);
  assert.equal(project.name, "beta");
  assert.equal(project.cwd, r.main);
});

test("project rows stored with a worktree's name and path are repaired at start", async (t) => {
  const r = repository(t);
  const dataDir = path.join(r.root, "data");
  let memory = new ProjectMemory({ dataDir, home: r.root });
  const { id } = await memory.register(r.main);
  // As an earlier version stored a project first seen from a worktree.
  for (const folder of [r.fenced, r.linked]) {
    memory.db
      .prepare("UPDATE projects SET name=?,cwd=? WHERE id=?")
      .run(path.basename(folder), folder, id);
    memory.close();
    const reopened = (memory = new ProjectMemory({ dataDir, home: r.root }));
    assert.deepEqual((({ name, cwd }) => ({ name, cwd }))(reopened.project(id)), {
      name: "beta",
      cwd: r.main,
    });
  }
  memory.close();
});

test("SSH and secret pickers show a remembered worktree project by its root", async (t) => {
  const r = repository(t);
  const f = await sshManagementFixture(t);
  const binding = await createSshProjectBinding(r.main);
  // As an earlier version remembered it from an agent's coding session.
  await f.management.registerProject(binding);
  await f.management.mutation(() => {
    const { projects } = f.management.catalog.read();
    f.management.catalog.replacePart(
      "projects",
      projects.map((row) =>
        row.id === binding.projectId
          ? { ...row, name: "agent-1234", cwd: r.fenced, directories: [r.fenced] }
          : row,
      ),
    );
  });
  const listed = (await f.management.projects()).projects.find(
    (row) => row.id === binding.projectId,
  );
  assert.equal(listed.name, "beta");
  assert.equal(listed.cwd, r.main);
});
