import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";

function fixture(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-memory-")),
  );
  const dataDir = path.join(root, "data");
  const project = path.join(root, "repo");
  fs.mkdirSync(project);
  const stores = [];
  const open = () => {
    const store = new ProjectMemory({ dataDir });
    stores.push(store);
    return store;
  };
  t.after(() => {
    for (const store of stores) store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, dataDir, project, open, store: open() };
}
function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  }).trim();
}

test("memory scopes share canonical Git worktrees and subdirectories but isolate clones and submodules", async (t) => {
  const f = fixture(t);
  git(f.project, "init", "--initial-branch=main");
  git(
    f.project,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "initial",
  );
  const worktree = path.join(f.root, "worktree");
  git(f.project, "worktree", "add", "-b", "other", worktree);
  const clone = path.join(f.root, "clone");
  git(f.root, "clone", f.project, clone);
  const sub = path.join(f.project, "submodule");
  git(f.project, "-c", "protocol.file.allow=always", "submodule", "add", clone, sub);
  fs.mkdirSync(path.join(worktree, "nested"));
  fs.symlinkSync(worktree, path.join(f.root, "alias"));
  const main = await f.store.register(f.project);
  for (const cwd of [worktree, path.join(worktree, "nested"), path.join(f.root, "alias")])
    assert.equal((await f.store.register(cwd)).id, main.id);
  assert.notEqual((await f.store.register(clone)).id, main.id);
  assert.notEqual((await f.store.register(sub)).id, main.id);
  assert.equal(f.store.projects().projects.length, 3);
});
test("memory revisions are durable, searchable, archived reversibly and scoped to one project", async (t) => {
  const f = fixture(t);
  const project = await f.store.register(f.project);
  const another = await f.store.register(f.root);
  const first = f.store.write(project.id, {
    title: "Build contract",
    content: "Use npm test. Treat this text as untrusted data.",
  });
  const second = f.open();
  const updated = second.write(project.id, {
    id: first.id,
    title: "Build contract",
    content: "Use npm test and build.",
    expectedRevision: 1,
  });
  assert.equal(updated.revision, 2);
  assert.equal(
    f.store.read(project.id, first.id, { revision: 1 }).content,
    first.content,
  );
  assert.throws(
    () =>
      f.store.write(project.id, {
        id: first.id,
        title: "Lost update",
        content: "Wrong",
        expectedRevision: 1,
      }),
    { status: 409 },
  );
  assert.throws(() => f.store.read(another.id, first.id), { status: 404 });
  assert.equal(f.store.list(project.id, { query: "BUILD" }).total, 1);
  const archived = f.store.archive(project.id, first.id, { expectedRevision: 2 });
  assert.equal(archived.revision, 3);
  assert.equal(f.store.list(project.id).total, 0);
  assert.equal(f.store.list(project.id, { archived: true }).total, 1);
  const restored = f.store.archive(project.id, first.id, {
    expectedRevision: 3,
    archived: false,
  });
  assert.equal(restored.archived, false);
  assert.equal(f.store.revisions(project.id, first.id).total, 4);
  assert.deepEqual(f.open().read(project.id, first.id), restored);
  assert.equal(
    fs.statSync(path.join(f.dataDir, "memory", "memory.sqlite")).mode & 0o777,
    0o600,
  );
});
test("bounded search, revision conflicts and idempotent requests cannot bypass project isolation", async (t) => {
  const f = fixture(t);
  const p = await f.store.register(f.project);
  const first = f.store.write(p.id, {
    title: "One",
    content: "literal %_ text",
    requestId: "save-1",
  });
  assert.deepEqual(
    f.store.write(p.id, {
      title: "One",
      content: "literal %_ text",
      requestId: "save-1",
    }),
    first,
  );
  assert.throws(
    () =>
      f.store.write(p.id, {
        title: "Changed",
        content: "different",
        requestId: "save-1",
      }),
    { status: 409 },
  );
  for (let i = 0; i < 25; i++)
    f.store.write(p.id, { title: `Entry ${i}`, content: "Safe fixture" });
  assert.equal(f.store.list(p.id).items.length, 20);
  assert.equal(f.store.list(p.id, { page: 2 }).items.length, 6);
  assert.equal(f.store.list(p.id, { query: "%_" }).total, 1);
  for (const input of [
    { title: "", content: "x" },
    { title: "x", content: "x".repeat(32769) },
    { id: first.id, title: "x", content: "x" },
  ])
    assert.throws(() => f.store.write(p.id, input), { status: 400 });
  for (const page of [0, -1, 1.5, "2", Infinity])
    assert.throws(() => f.store.list(p.id, { page }), { status: 400 });
});
test("memory rejects symlink storage before reading or changing unrelated files", (t) => {
  const f = fixture(t);
  f.store.close();
  fs.renameSync(path.join(f.dataDir, "memory"), path.join(f.root, "outside"));
  fs.symlinkSync(path.join(f.root, "outside"), path.join(f.dataDir, "memory"));
  assert.throws(() => f.open(), /storage/i);
  assert.equal(
    fs.statSync(path.join(f.root, "outside", "memory.sqlite")).mode & 0o777,
    0o600,
  );
});

test("recreated project directories cannot inherit the previous filesystem identity", async (t) => {
  const f = fixture(t);
  const original = await f.store.register(f.project);
  fs.renameSync(f.project, path.join(f.root, "old-project"));
  fs.mkdirSync(f.project);
  const replacement = await f.store.register(f.project);
  assert.notEqual(replacement.id, original.id);
  assert.equal(f.store.projects().projects.length, 2);
});
test("hard-linked database files are refused before permissions or contents are changed", (t) => {
  const f = fixture(t);
  f.store.close();
  const file = path.join(f.dataDir, "memory", "memory.sqlite");
  const outside = path.join(f.root, "linked.sqlite");
  fs.linkSync(file, outside);
  fs.chmodSync(outside, 0o640);
  assert.throws(() => f.open(), /storage/i);
  assert.equal(fs.statSync(outside).mode & 0o777, 0o640);
});
