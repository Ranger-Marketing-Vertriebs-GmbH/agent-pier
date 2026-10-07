import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import { issueCapability } from "../../server/features/memory/memory-capability.js";
import {
  classifyProjectFolder,
  runWorktreeRoot,
} from "../../server/features/memory/project-folders.js";

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "memory-identity-")),
  );
  const home = path.join(root, "home");
  fs.mkdirSync(home);
  const memory = new ProjectMemory({ dataDir: path.join(root, "data"), home });
  t.after(() => {
    memory.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, home, memory };
}
function folder(...parts) {
  const cwd = path.join(...parts);
  fs.mkdirSync(cwd, { recursive: true });
  return cwd;
}
function repository(...parts) {
  const cwd = folder(...parts);
  execFileSync("git", ["init", "-q", cwd]);
  return cwd;
}
function commit(cwd) {
  fs.writeFileSync(path.join(cwd, "README.md"), "x\n");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.invalid",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.invalid",
  };
  execFileSync("git", ["-C", cwd, "add", "."], { env });
  execFileSync("git", ["-C", cwd, "commit", "-qm", "init"], { env });
}
const rows = (memory) =>
  memory.db.prepare("SELECT id,name,cwd,kind FROM projects ORDER BY cwd").all();

test("re-registering a folder after git init keeps one row and its entries", async (t) => {
  const { root, memory } = fixture(t);
  const cwd = folder(root, "work", "electronic-lab");
  const plain = await memory.register(cwd);
  memory.write(plain.id, { title: "Wiring", content: "Kept after git init" });
  issueCapability(memory, {
    id: "s1",
    account: { id: "local-codex", tool: "codex" },
    projectId: plain.id,
  });
  execFileSync("git", ["init", "-q", cwd]);
  const git = await memory.register(cwd);
  assert.equal(git.kind, "git");
  assert.notEqual(git.id, plain.id);
  assert.deepEqual(
    rows(memory).map((row) => [row.cwd, row.kind]),
    [[cwd, "git"]],
  );
  assert.equal(memory.list(git.id).total, 1);
  assert.equal(memory.reboundTo(plain.id), git.id);
  assert.equal(
    memory.db.prepare("SELECT project_id FROM capabilities WHERE session_id='s1'").get()
      .project_id,
    git.id,
  );
  assert.equal((await memory.register(cwd)).id, git.id);
  assert.equal(rows(memory).length, 1);
});

test("a Git identity that already owns knowledge never absorbs the plain folder", async (t) => {
  const { root, memory } = fixture(t);
  const cwd = folder(root, "work", "spoolops");
  const plain = await memory.register(cwd);
  memory.write(plain.id, { title: "Old", content: "From the plain folder" });
  execFileSync("git", ["init", "-q", cwd]);
  // Data the Git identity holds already, as after restoring an older .git.
  const scope = await projectScope(cwd);
  memory.db
    .prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
    .run(scope.id, scope.name, scope.cwd, scope.kind, scope.identity, "2026-01-01");
  memory.write(scope.id, { title: "Restored", content: "Git identity data" });
  assert.equal((await memory.register(cwd)).id, scope.id);
  assert.equal(rows(memory).length, 2);
  assert.equal(memory.list(plain.id).total, 1);
  assert.equal(memory.reboundTo(plain.id), null);
});

test("home, collection folders and run worktrees create no project of their own", async (t) => {
  const { root, home, memory } = fixture(t);
  assert.equal(await memory.register(home), null);
  const projects = folder(root, "Projects");
  repository(projects, "one");
  repository(projects, "two");
  folder(projects, "scratch");
  assert.equal(await memory.register(projects), null);
  const app = repository(projects, "app");
  commit(app);
  const run = path.join(app, ".agentpier-worktrees", "4f1d2c3b-run");
  execFileSync("git", ["-C", app, "worktree", "add", "-q", "--detach", run]);
  const fromRun = await memory.register(run);
  assert.deepEqual([fromRun.cwd, fromRun.name], [app, "app"]);
  assert.equal((await memory.register(app)).id, fromRun.id);
  assert.deepEqual(
    rows(memory).map((row) => row.cwd),
    [app],
  );
});

test("a run worktree registered first moves its project row to the root", async (t) => {
  const { root, memory } = fixture(t);
  const app = repository(root, "work", "app");
  commit(app);
  const run = path.join(app, ".agentpier-worktrees", "1234abcd");
  execFileSync("git", ["-C", app, "worktree", "add", "-q", "--detach", run]);
  const scope = await memory.register(app);
  memory.db
    .prepare("UPDATE projects SET cwd=?,name=? WHERE id=?")
    .run(run, "1234abcd", scope.id);
  const registered = await memory.register(app);
  assert.deepEqual(
    [registered.id, registered.cwd, registered.name],
    [scope.id, app, "app"],
  );
});

test("excluded folders that already hold knowledge keep working", async (t) => {
  const { root, home, memory } = fixture(t);
  const projects = folder(root, "Projects");
  repository(projects, "one");
  repository(projects, "two");
  // A home project registered by an older release.
  const scope = await projectScope(home);
  memory.db
    .prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
    .run(scope.id, scope.name, scope.cwd, scope.kind, scope.identity, "2026-01-01");
  memory.write(scope.id, { title: "Kept", content: "Home notes" });
  const kept = await memory.register(home);
  assert.deepEqual([kept.id, kept.cwd], [scope.id, home]);
  assert.equal(memory.list(kept.id).total, 1);
  assert.equal(await memory.register(projects), null);
});

test("the collection-folder rule is conservative", async (t) => {
  const { root, home } = fixture(t);
  const isRegistered = () => false;
  const classify = (cwd, registered = isRegistered) =>
    classifyProjectFolder(cwd, { home, isRegistered: registered }).then((f) => f.kind);
  const one = folder(root, "one-repo");
  repository(one, "a");
  folder(one, "b");
  assert.equal(await classify(one), "project", "one child project is not enough");
  const registered = folder(root, "registered");
  folder(registered, "x");
  folder(registered, "y");
  assert.equal(await classify(registered), "project");
  assert.equal(
    await classify(registered, (dir) => dir.startsWith(registered + path.sep)),
    "collection",
    "registered child projects count",
  );
  const monorepo = repository(root, "monorepo");
  repository(monorepo, "a");
  repository(monorepo, "b");
  assert.equal(await classify(monorepo), "project", "a git repository is a project");
  assert.equal(await classify(home), "home");
  assert.equal(
    runWorktreeRoot(path.join(root, "app", ".agentpier-worktrees", "r1")),
    path.join(root, "app"),
  );
  assert.equal(
    runWorktreeRoot(path.join(root, "app", ".agentpier-worktrees", "r1", "src")),
    path.join(root, "app"),
  );
  assert.equal(runWorktreeRoot(path.join(root, "app")), null);
});
