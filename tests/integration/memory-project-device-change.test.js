import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import {
  projectScope,
  stableIdentity,
} from "../../server/features/memory/project-scope.js";
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
 * Stores the folder's project as an earlier boot registered it: the same path and
 * inode under another device number (macOS renumbers volumes at boot).
 */
async function registeredBeforeRestart(memory, cwd) {
  const scope = await projectScope(cwd, { known: false });
  const [kind, place, dev, ino] = JSON.parse(scope.identity);
  const parts = [kind, place, String(BigInt(dev) + 2n), ino];
  const id = hash(parts);
  memory.db
    .prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
    .run(id, scope.name, scope.cwd, kind, JSON.stringify(parts), "2026-09-08T10:00:00Z");
  return id;
}
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

test("an exact identity wins over an older row of the same folder", async (t) => {
  const { root, memory } = fixture(t);
  const cwd = path.join(root, "electronic-lab");
  execFileSync("git", ["init", "-q", cwd]);
  await registeredBeforeRestart(memory, cwd);
  const own = await projectScope(cwd, { known: false });
  memory.db
    .prepare("INSERT INTO projects VALUES (?,?,?,?,?,?)")
    .run(own.id, own.name, own.cwd, own.kind, own.identity, "2026-10-22T11:49:35Z");
  assert.equal((await memory.register(cwd)).id, own.id);
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
  assert.notEqual((await projectScope(cwd)).id, earlier);
});

test("stableIdentity ignores only the device number", () => {
  assert.equal(
    stableIdentity(JSON.stringify(["git", "/p/.git", "1", "7"])),
    stableIdentity(JSON.stringify(["git", "/p/.git", "2", "7"])),
  );
  assert.notEqual(
    stableIdentity(JSON.stringify(["git", "/p/.git", "1", "7"])),
    stableIdentity(JSON.stringify(["git", "/p/.git", "1", "8"])),
  );
  assert.equal(stableIdentity("not json"), null);
});
