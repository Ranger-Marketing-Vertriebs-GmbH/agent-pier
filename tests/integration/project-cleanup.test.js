import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { applicationFixture } from "../helpers/application.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { issueCapability } from "../../server/features/memory/memory-capability.js";
import { cleanupName } from "../../server/application/project-cleanup.js";

const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@example.invalid",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@example.invalid",
};
function repository(cwd, { commit = false } = {}) {
  fs.mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  if (commit) {
    fs.writeFileSync(path.join(cwd, "README.md"), "x\n");
    execFileSync("git", ["-C", cwd, "add", "."], { env });
    execFileSync("git", ["-C", cwd, "commit", "-qm", "init"], { env });
  }
  return cwd;
}
// Rows as older releases wrote them, bypassing today's registration rules.
async function legacyRow(memory, cwd, scope) {
  scope ||= await projectScope(cwd);
  memory.db
    .prepare("INSERT OR IGNORE INTO projects VALUES (?,?,?,?,?,?)")
    .run(scope.id, path.basename(cwd), cwd, scope.kind, scope.identity, "2026-01-01");
  return scope.id;
}
const listed = (memory) =>
  memory
    .projects()
    .projects.map((p) => [path.basename(p.cwd), p.kind, p.entryCount])
    .sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

test("the startup cleanup merges duplicates and removes only empty junk rows, once", async (t) => {
  const app = await applicationFixture(t);
  let memory = app.application.memory;
  // A folder registered before git init and again after it.
  const lab = path.join(app.root, "work", "electronic-lab");
  fs.mkdirSync(lab, { recursive: true });
  const plain = await legacyRow(memory, lab);
  memory.write(plain, { title: "Before", content: "Plain folder note" });
  execFileSync("git", ["init", "-q", lab]);
  const git = await legacyRow(memory, lab);
  memory.write(git, { title: "After", content: "Git folder note" });
  // Junk rows: an empty home, an empty and a used collection folder.
  await legacyRow(memory, app.home);
  const collection = path.join(app.root, "Projects");
  repository(path.join(collection, "one"));
  repository(path.join(collection, "two"));
  await legacyRow(memory, collection);
  const used = path.join(app.root, "Used");
  repository(path.join(used, "a"));
  repository(path.join(used, "b"));
  const usedId = await legacyRow(memory, used);
  memory.write(usedId, { title: "Kept", content: "Collection note" });
  // A run worktree that registered its project before the root did.
  const appRoot = repository(path.join(app.root, "work", "app"), { commit: true });
  const run = path.join(appRoot, ".agentpier-worktrees", "5e1f0c2a");
  execFileSync("git", ["-C", appRoot, "worktree", "add", "-q", "--detach", run]);
  await legacyRow(memory, run, await projectScope(run));
  // A removed run worktree of another project, with nothing attached.
  const gone = path.join(app.root, "work", "old", ".agentpier-worktrees", "a1b2c3d4");
  await legacyRow(memory, gone, {
    id: "c".repeat(64),
    kind: "git",
    identity: "[]",
  });
  // A session that still holds a capability on another empty run worktree row.
  const held = path.join(app.root, "work", "old", ".agentpier-worktrees", "e5f6a7b8");
  await legacyRow(memory, held, { id: "d".repeat(64), kind: "git", identity: "[]" });
  issueCapability(memory, {
    id: "held-session",
    account: { id: "local-codex", tool: "codex" },
    projectId: "d".repeat(64),
  });
  memory.db.prepare("DELETE FROM migrations").run();
  await app.restart();
  memory = app.application.memory;
  assert.deepEqual(listed(memory), [
    ["app", "git", 0],
    ["e5f6a7b8", "git", 0],
    ["electronic-lab", "git", 2],
    ["Used", "directory", 1],
  ]);
  assert.equal(memory.reboundTo(plain), git);
  assert.ok(memory.migrationApplied(cleanupName));
  const backups = fs
    .readdirSync(memory.root)
    .filter((name) => name.includes("before-project-cleanup"));
  assert.equal(backups.length, 1);
  assert.equal(fs.statSync(path.join(memory.root, backups[0])).mode & 0o777, 0o600);
  assert.ok(fs.existsSync(collection) && fs.existsSync(app.home), "never deletes files");
  // Idempotent: a later start changes nothing and writes no further backup.
  await legacyRow(memory, app.home);
  await app.restart();
  memory = app.application.memory;
  assert.ok(listed(memory).some(([name]) => name === path.basename(app.home)));
  assert.equal(
    fs.readdirSync(memory.root).filter((name) => name.includes("before-project-cleanup"))
      .length,
    1,
  );
});
