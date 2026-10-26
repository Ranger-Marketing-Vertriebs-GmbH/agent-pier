import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { channelFixture } from "../helpers/assistant-channel-fixture.js";
import { NativeMemory } from "../../server/features/assistants/native-memory.js";

// AGENTPIER-234: dreaming writes three notes a night, so an agent passes 200 notes
// within weeks. The memory view lists them newest first in pages of 200; the rest
// is reached page by page, never as an arbitrary selection of the folder.
function fixture(t) {
  const f = channelFixture(t);
  const id = f.channel.assistantId;
  f.store.updateAssistant(id, { capabilities: { memory: true, reminders: false } }, 1);
  f.assistants.admit = (fn) => fn();
  const workspaces = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "memory-paging-")),
  );
  t.after(() => fs.rmSync(workspaces, { recursive: true, force: true }));
  const root = path.join(workspaces, id);
  const put = (name, text, minute) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    const time = new Date(Date.UTC(2026, 9, 1, 0, minute));
    fs.utimesSync(file, time, time);
  };
  return { id, root, put, memory: new NativeMemory(f.assistants, { workspaces }) };
}

const note = (i) => `memory/dreaming/light/2026-${String(i).padStart(4, "0")}.md`;

test("the memory view pages notes newest first and reaches every note", async (t) => {
  const f = fixture(t);
  f.put("DREAMS.md", "# Dream Diary", 0);
  // Written in a shuffled order, so the folder's order is not the answer's.
  const order = Array.from({ length: 250 }, (_, i) => (i * 97) % 250);
  for (const i of order) f.put(note(i), `note ${i}`, i);
  const first = await f.memory.files(f.id);
  assert.equal(first.total, 250);
  assert.equal(first.nextOffset, 200);
  assert.equal(first.files.length, 201);
  assert.equal(first.files[0].name, "DREAMS.md");
  const names = first.files.slice(1).map((x) => x.name);
  assert.deepEqual(
    names,
    Array.from({ length: 200 }, (_, i) => note(249 - i)),
  );
  const second = await f.memory.files(f.id, { offset: first.nextOffset });
  assert.equal(second.total, 250);
  assert.equal(second.nextOffset, null);
  // The diary heads the first page only.
  assert.deepEqual(
    second.files.map((x) => x.name),
    Array.from({ length: 50 }, (_, i) => note(49 - i)),
  );
  assert.deepEqual(await f.memory.files(f.id, { offset: 250 }), {
    files: [],
    total: 250,
    nextOffset: null,
  });
});

test("notes written in the same instant keep one order by name", async (t) => {
  const f = fixture(t);
  for (const name of ["memory/b.md", "memory/c.md", "memory/a.md"]) f.put(name, "x", 5);
  f.put("memory/z.md", "older", 1);
  for (let run = 0; run < 3; run++)
    assert.deepEqual(
      (await f.memory.files(f.id)).files.map((x) => x.name),
      ["memory/a.md", "memory/b.md", "memory/c.md", "memory/z.md"],
    );
});

test("a page offset must be a whole number within bounds", async (t) => {
  const f = fixture(t);
  f.put("memory/a.md", "x", 1);
  for (const offset of [-1, 1.5, "2", Number.NaN, 1e9])
    await assert.rejects(f.memory.files(f.id, { offset }), { status: 400 }, `${offset}`);
  assert.deepEqual(await f.memory.files(f.id, { offset: 0 }), {
    files: [
      {
        name: "memory/a.md",
        size: 1,
        modifiedAt: new Date(Date.UTC(2026, 9, 1, 0, 1)).toISOString(),
      },
    ],
    total: 1,
    nextOffset: null,
  });
});
