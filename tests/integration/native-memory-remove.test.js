import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { NativeMemory } from "../../server/features/assistants/native-memory.js";

function fixture(t) {
  const f = channelFixture(t);
  const id = f.channel.assistantId;
  f.store.updateAssistant(id, { capabilities: { memory: true, reminders: false } }, 1);
  let changes = 0;
  f.assistants.admit = (fn) => fn();
  f.assistants.changed = () => changes++;
  const workspaces = path.join(f.dataDir, "workspaces");
  const root = path.join(workspaces, id);
  fs.mkdirSync(path.join(root, "memory", "people"), { recursive: true });
  fs.writeFileSync(path.join(root, "MEMORY.md"), "Long term");
  fs.writeFileSync(path.join(root, "memory", "people", "anna.md"), "Likes tea");
  return {
    ...f,
    id,
    root,
    changes: () => changes,
    memory: new NativeMemory(f.assistants, { workspaces }),
  };
}

test("remove deletes a memory note and refuses MEMORY.md", async (t) => {
  const f = fixture(t);
  await f.memory.remove(f.id, "memory/people/anna.md");
  assert.equal(fs.existsSync(path.join(f.root, "memory", "people", "anna.md")), false);
  assert.equal(f.changes(), 1);
  assert.deepEqual((await f.memory.files(f.id)).files, []);
  await assert.rejects(f.memory.remove(f.id, "memory/people/anna.md"), { status: 404 });
  for (const name of ["MEMORY.md", "USER.md", "notes.md", "memory/../MEMORY.md", 7])
    await assert.rejects(f.memory.remove(f.id, name), { status: 400 }, String(name));
  assert.equal(fs.readFileSync(path.join(f.root, "MEMORY.md"), "utf8"), "Long term");
});

test("remove never follows a link out of the workspace", async (t) => {
  const f = fixture(t);
  const outside = path.join(f.dataDir, "outside.md");
  fs.writeFileSync(outside, "Private");
  fs.symlinkSync(outside, path.join(f.root, "memory", "link.md"));
  await assert.rejects(f.memory.remove(f.id, "memory/link.md"), { status: 400 });
  assert.equal(fs.readFileSync(outside, "utf8"), "Private");
});
