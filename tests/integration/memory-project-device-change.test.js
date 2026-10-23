import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import { projectScope } from "../../server/features/memory/project-scope.js";
import {
  directoryProjectId,
  folderIdentity,
} from "../../server/features/memory/project-rebind.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memory-device-")));
  const memory = new ProjectMemory({
    dataDir: path.join(root, "data"),
    home: path.join(root, "home"),
  });
  t.after(() => {
    memory.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, memory };
}
const hash = (parts) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/**
 * The project ID as every release derives it, computed here independently: sha256
 * of [kind, Git common directory or folder, device, inode]. `shift` renumbers the
 * device the way macOS does at boot.
 */
function oldIdentity(cwd, shift = 0n) {
  const git = fs.existsSync(path.join(cwd, ".git"));
  const place = fs.realpathSync(git ? path.join(cwd, ".git") : cwd);
  const stat = fs.statSync(place, { bigint: true });
  const parts = [
    git ? "git" : "directory",
    place,
    String(stat.dev + shift),
    String(stat.ino),
  ];
  return { id: hash(parts), parts };
}
function insert(memory, cwd, { id, parts }, createdAt) {
  memory.db
    .prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
    .run(id, path.basename(cwd), cwd, parts[0], JSON.stringify(parts), createdAt);
  return id;
}
/** The folder's project as an earlier boot registered it (another device number). */
const registeredBeforeRestart = (memory, cwd) =>
  insert(memory, cwd, oldIdentity(cwd, 2n), "2026-09-08T10:00:00Z");
const rows = (memory) =>
  memory.db
    .prepare("SELECT id FROM projects")
    .all()
    .map(({ id }) => ({ id }));

test("a restart that renumbers the volume keeps the folder's project", async (t) => {
  const { root, memory } = fixture(t);
  const cwd = path.join(root, "agent-pier");
  execFileSync("git", ["init", "-q", cwd]);
  const earlier = await registeredBeforeRestart(memory, cwd);
  memory.write(earlier, { title: "Kept", content: "Written before the restart" });

  assert.equal((await projectScope(cwd)).id, earlier);
  assert.equal((await memory.register(cwd)).id, earlier);
  assert.equal((await memory.register(cwd)).id, earlier);
  assert.deepEqual(rows(memory), [{ id: earlier }]);
});

test("a plain folder keeps its project across a renumbered volume", async (t) => {
  const { root, memory } = fixture(t);
  const cwd = path.join(root, "test-trading");
  fs.mkdirSync(cwd);
  const earlier = await registeredBeforeRestart(memory, cwd);
  assert.equal((await memory.register(cwd)).id, earlier);
  // The git-init rebind finds the plain-folder row by the same rule.
  assert.equal(directoryProjectId(folderIdentity(cwd)), earlier);
  assert.equal(rows(memory).length, 1);
});

test("the newest row of a folder stays current when an earlier device number returns", async (t) => {
  const { root, memory } = fixture(t);
  const cwd = path.join(root, "electronic-lab");
  execFileSync("git", ["init", "-q", cwd]);
  // Registered under today's device number first, then again after a renumbering;
  // this boot got the first device number back, so the older row matches exactly.
  const exact = insert(memory, cwd, oldIdentity(cwd), "2026-10-03T15:47:21Z");
  const newest = insert(memory, cwd, oldIdentity(cwd, 2n), "2026-10-23T09:40:54Z");
  assert.equal((await projectScope(cwd)).id, newest);
  assert.equal((await memory.register(cwd)).id, newest);
  assert.notEqual(exact, newest);
  assert.equal(rows(memory).length, 2);
});

test("a replaced folder (new inode) still gets its own project", async (t) => {
  const { root, memory } = fixture(t);
  const cwd = path.join(root, "replaced");
  fs.mkdirSync(cwd);
  const before = folderIdentity(cwd).ino;
  const first = (await memory.register(cwd)).id;
  fs.rmSync(cwd, { recursive: true });
  fs.mkdirSync(path.join(root, "pad"));
  fs.mkdirSync(cwd);
  if (folderIdentity(cwd).ino === before) return t.skip("the inode was reused");
  assert.notEqual((await memory.register(cwd)).id, first);
});

test("a closed store no longer answers for its folders", async (t) => {
  const { root, memory } = fixture(t);
  const cwd = path.join(root, "closed");
  fs.mkdirSync(cwd);
  const earlier = await registeredBeforeRestart(memory, cwd);
  memory.close();
  const scope = await projectScope(cwd);
  assert.notEqual(scope.id, earlier);
  assert.equal(scope.id, oldIdentity(cwd).id);
});
