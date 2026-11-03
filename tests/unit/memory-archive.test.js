import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  archiveEntries,
  memoryArchiveOf,
  restoreEntry,
} from "../../server/features/assistants/memory-archive.js";

// A service whose agent runs on `runtime`, with its memory files in `files` and a
// write that `fail` may refuse.
function stub(runtime, files) {
  const service = {
    store: { db: new DatabaseSync(":memory:"), getAssistant: (id) => ({ id, runtime }) },
    audit: { events: [], append: (event) => service.audit.events.push(event) },
    fail: null,
    nativeMemory: {
      read: async (_id, name) =>
        name in files
          ? { content: files[name], missing: false, hash: `h${files[name].length}` }
          : { content: "", missing: true, hash: null },
      write: async (_id, { name, content }) => {
        if (service.fail) throw service.fail;
        files[name] = content;
      },
      writeNote: async () => {
        throw new Error("no notes");
      },
    },
  };
  return service;
}
const meta = { switch: { from: "A", to: "B" }, reviewId: "r1" };

test("archives a Hermes block and restores it as a block", async () => {
  const files = { "MEMORY.md": "Owner writes German.\n§\nNo keyloggers.\n§\nRepo X." };
  const service = stub("hermes", files);
  const result = await archiveEntries(
    service,
    "a1",
    [{ file: "MEMORY.md", entry: "No keyloggers." }],
    meta,
  );
  assert.deepEqual(result, { archived: 1, changed: [] });
  assert.equal(files["MEMORY.md"], "Owner writes German.\n§\nRepo X.");
  const [entry] = memoryArchiveOf(service).list("a1");
  assert.deepEqual(
    {
      file: entry.file,
      text: entry.text,
      switch: entry.switch,
      reviewId: entry.reviewId,
    },
    { file: "MEMORY.md", text: "No keyloggers.", switch: meta.switch, reviewId: "r1" },
  );
  assert.deepEqual(await restoreEntry(service, "a1", entry.id), {
    restored: true,
    file: "MEMORY.md",
  });
  assert.equal(files["MEMORY.md"], "Owner writes German.\n§\nRepo X.\n§\nNo keyloggers.");
  assert.deepEqual(memoryArchiveOf(service).list("a1"), []);
});

test("a Hermes restore past Hermes's limit is refused and stays archived", async () => {
  const files = { "USER.md": "Gone." };
  const service = stub("hermes", files);
  await archiveEntries(service, "a1", [{ file: "USER.md", entry: "Gone." }], meta);
  assert.equal(files["USER.md"], "");
  files["USER.md"] = "x".repeat(1373);
  const [entry] = memoryArchiveOf(service).list("a1");
  await assert.rejects(restoreEntry(service, "a1", entry.id), {
    status: 409,
    key: "memoryTooLarge",
  });
  assert.equal(files["USER.md"], "x".repeat(1373));
  assert.equal(memoryArchiveOf(service).list("a1").length, 1);
});

test("a failed write keeps the entry in its file and out of the archive", async () => {
  const files = { "MEMORY.md": "- Keep.\n- Archive me.\n" };
  const service = stub("openclaw", files);
  service.fail = Object.assign(new Error("down"), { status: 503 });
  await assert.rejects(
    archiveEntries(service, "a1", [{ file: "MEMORY.md", entry: "Archive me." }], meta),
    { status: 503 },
  );
  assert.equal(files["MEMORY.md"], "- Keep.\n- Archive me.\n");
  assert.deepEqual(memoryArchiveOf(service).list("a1"), []);
  assert.deepEqual(service.audit.events, []);
});

test("refuses files that are no memory file of the agent", async () => {
  const service = stub("openclaw", {});
  for (const file of ["AGENTS.md", "memory/.dreams/corpus.md", "memory/lead/MEMORY.md"])
    await assert.rejects(
      archiveEntries(service, "a1", [{ file, entry: "x" }], meta),
      { status: 400 },
      file,
    );
  // Hermes keeps no notes.
  await assert.rejects(
    archiveEntries(
      stub("hermes", {}),
      "a1",
      [{ file: "memory/2026-11-01.md", entry: "x" }],
      meta,
    ),
    { status: 400 },
  );
  await assert.rejects(restoreEntry(service, "a1", "unknown"), { status: 404 });
});
