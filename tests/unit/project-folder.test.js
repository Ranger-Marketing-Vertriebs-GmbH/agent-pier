import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createProjectFolder,
  projectFolderName,
} from "../../server/features/projects/project-folder.js";

function fixture(t, { defaultCwd } = {}) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pfolder-")));
  t.after(() => {
    fs.chmodSync(parent, 0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const projects = [];
  const memory = {
    claimsFolder: () => false,
    projectNames: () => projects.map((p) => ({ id: p.id })),
    register: async (cwd) => {
      const project = { id: `p${projects.length + 1}`, cwd, name: path.basename(cwd) };
      projects.push(project);
      return project;
    },
    removeEmpty: (id) => {
      projects.splice(
        projects.findIndex((p) => p.id === id),
        1,
      );
    },
  };
  const preferences = { get: () => ({ defaultCwd: defaultCwd ?? parent }) };
  return { parent, projects, memory, preferences };
}

test("creates, registers and git-inits a fresh folder", async (t) => {
  const f = fixture(t);
  const made = await createProjectFolder({ ...f, name: "Alpha" });
  t.after(() => made.release());
  assert.equal(made.path, path.join(f.parent, "Alpha"));
  assert.ok(fs.existsSync(path.join(made.path, ".git")));
  assert.equal(made.project.cwd, made.path);
  assert.equal(f.projects.length, 1);
});

test("a taken name gets a suffix when unique", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.parent, "Alpha"));
  fs.mkdirSync(path.join(f.parent, "Alpha 2"));
  const made = await createProjectFolder({
    ...f,
    name: "Alpha",
    unique: true,
    git: false,
  });
  t.after(() => made.release());
  assert.equal(path.basename(made.path), "Alpha 3");
  await assert.rejects(createProjectFolder({ ...f, name: "Alpha", git: false }), {
    status: 409,
  });
  assert.deepEqual(fs.readdirSync(f.parent).sort(), ["Alpha", "Alpha 2", "Alpha 3"]);
});

test("refuses an unwritable default folder and leaves nothing", async (t) => {
  const f = fixture(t);
  fs.chmodSync(f.parent, 0o500);
  if (process.getuid?.() === 0) return t.skip("root ignores directory modes");
  await assert.rejects(createProjectFolder({ ...f, name: "Nope" }), { status: 409 });
  fs.chmodSync(f.parent, 0o700);
  assert.deepEqual(fs.readdirSync(f.parent), []);
  const missing = fixture(t, { defaultCwd: path.join(f.parent, "missing") });
  await assert.rejects(createProjectFolder({ ...missing, name: "Nope" }), {
    status: 409,
  });
  assert.equal(missing.projects.length, 0);
});

test("rollback removes only the folder it made", async (t) => {
  const f = fixture(t);
  const mine = await createProjectFolder({ ...f, name: "Mine", git: false });
  await mine.rollback();
  assert.equal(fs.existsSync(mine.path), false);
  assert.equal(f.projects.length, 0);
  // A replaced folder stays.
  const other = await createProjectFolder({ ...f, name: "Other", git: false });
  const logged = t.mock.method(console, "error", () => {});
  fs.rmdirSync(other.path);
  fs.mkdirSync(other.path);
  fs.writeFileSync(path.join(other.path, "theirs"), "x");
  await other.rollback();
  assert.ok(fs.existsSync(path.join(other.path, "theirs")));
  assert.equal(logged.mock.callCount(), 1);
  // A failed git init removes the folder.
  await assert.rejects(
    createProjectFolder({
      ...f,
      name: "Broken",
      gitInit: async () => {
        throw Error("boom");
      },
    }),
    { status: 409 },
  );
  assert.equal(fs.existsSync(path.join(f.parent, "Broken")), false);
});

test("projectFolderName turns a request into a folder name", () => {
  assert.equal(
    projectFolderName("Rebuild the  Todo app\nplease"),
    "Rebuild the Todo app please",
  );
  assert.equal(projectFolderName("a/b\\c"), "a b c");
  assert.equal(projectFolderName("x".repeat(100)).length, 60);
  assert.equal(projectFolderName("  ..  "), "Rebuild");
  assert.equal(projectFolderName(""), "Rebuild");
  assert.equal(projectFolderName(undefined), "Rebuild");
});
