import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProjectMemory } from "../../server/features/memory/project-memory.js";
import {
  createProjectFolder,
  initRepository,
} from "../../server/features/projects/project-folder.js";

// A rebuild's folder is made without Git and git-inited once Craft Anything took it
// on (craft-rebuilds.js): registering it again moves it to one Git project.
test("a folder git-inited after creation keeps one project when registered again", async (t) => {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pfolder-git-")));
  const memory = new ProjectMemory({
    dataDir: path.join(parent, "data"),
    home: path.join(parent, "home"),
  });
  t.after(() => {
    memory.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  const preferences = { get: () => ({ defaultCwd: parent }) };
  const made = await createProjectFolder({
    preferences,
    memory,
    name: "Late",
    git: false,
  });
  await initRepository(made.path);
  const again = await memory.register(made.path);
  await made.release();
  assert.notEqual(again.id, made.project.id);
  assert.equal(again.kind, "git");
  assert.deepEqual(
    memory.projectNames().map((p) => p.id),
    [again.id],
  );
  assert.equal((await memory.register(made.path)).id, again.id);
});
