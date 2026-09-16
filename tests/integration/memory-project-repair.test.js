import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { projectScope } from "../../server/features/memory/project-scope.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memory-repair-")));
  const repo = path.join(root, "repo"),
    worktree = path.join(root, "temporary");
  const git = (...args) =>
    execFileSync("git", args, {
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdio: "pipe",
    });
  git("init", "-q", repo);
  git(
    "-C",
    repo,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-qm",
    "initial",
  );
  git("-C", repo, "worktree", "add", "-qb", "temporary", worktree);
  const dataDir = path.join(root, "data"),
    memory = new ProjectMemory({ dataDir });
  t.after(() => {
    memory.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, repo, worktree, git, dataDir, memory };
}
for (const replaced of [false, true]) {
  test(`registration repairs a ${replaced ? "replaced" : "removed"} first checkout without losing history`, async (t) => {
    const f = fixture(t),
      original = await f.memory.register(f.worktree);
    const written = f.memory.write(original.id, {
      title: "Contract",
      content: "Retained knowledge",
    });
    f.git("-C", f.repo, "worktree", "remove", f.worktree);
    if (replaced) fs.mkdirSync(f.worktree);
    const repaired = await f.memory.register(f.repo);
    assert.equal(repaired.id, original.id);
    assert.equal(repaired.cwd, f.repo);
    assert.equal(repaired.createdAt, original.createdAt);
    assert.equal((await projectScope(repaired.cwd)).id, repaired.id);
    assert.equal(f.memory.read(repaired.id, written.id).content, "Retained knowledge");
    const reopened = new ProjectMemory({ dataDir: f.dataDir });
    try {
      assert.equal(reopened.project(original.id).cwd, f.repo);
    } finally {
      reopened.close();
    }
  });
}
test("registering another valid checkout keeps the existing project launch directory", async (t) => {
  const f = fixture(t),
    first = await f.memory.register(f.worktree);
  const second = await f.memory.register(f.repo);
  assert.equal(second.cwd, f.worktree);
  assert.equal(second.id, first.id);
});
