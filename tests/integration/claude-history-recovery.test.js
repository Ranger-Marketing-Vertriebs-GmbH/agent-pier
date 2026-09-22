import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { claudeHistoryFixture } from "../helpers/claude-history.js";
import { ChatStore } from "../../server/features/chat/chat-store.js";
import { JsonlHistoryReader } from "../../server/features/chat/jsonl-history-reader.js";
import { problem } from "../../server/lib/storage.js";

const conversation = (f, count, prefix = "") =>
  Array.from({ length: count }, (_, i) =>
    i % 2
      ? f.assistant(`${prefix}r${i}`, [{ type: "text", text: `${prefix}answer ${i}` }])
      : f.user(`${prefix}r${i}`, `${prefix}prompt ${i}`),
  );

function countReads(t) {
  const counter = { bytes: 0 };
  const open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle);
    handle.read = async (...values) => {
      const result = await read(...values);
      counter.bytes += result.bytesRead;
      return result;
    };
    return handle;
  });
  return counter;
}

test("a transcript rewritten in place stays readable and rebuilds its index", async (t) => {
  const f = await claudeHistoryFixture(t);
  await f.write(conversation(f, 120));
  f.session.status = "running";
  const events = [];
  const store = new ChatStore({
    dataDir: path.join(f.home, "pier"),
    sessions: { get: async () => f.session },
    history: f.history,
    events: { publish: (...args) => events.push(args) },
  });
  store.initialize(f.session, "native");
  await store.read(f.session.id);
  await f.indexed();
  const ready = await store.read(f.session.id);
  assert.ok(ready.history.cursor);
  const inode = (await fs.stat(f.file)).ino;
  await f.write(conversation(f, 60, "new-"));
  assert.equal((await fs.stat(f.file)).ino, inode, "same inode, smaller file");
  const page = await f.history.readPage(f.session, "native");
  assert.equal(page.messages.at(-1).text, "new-answer 59");
  await f.indexed();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.at(-1)[1], "binding-changed", "rebuilt index replaces cursors");
  const rebuilt = await f.pages();
  assert.ok(rebuilt.first.next?.indexed, "served from the rebuilt index");
  assert.equal(rebuilt.messages.length, 60);
  await assert.rejects(store.older(f.session.id, ready.history.cursor), {
    status: 409,
  });
});

test("an oversized provisional read still starts the index and reports indexing", async (t) => {
  const f = await claudeHistoryFixture(t);
  await f.write(conversation(f, 120));
  const backwards = JsonlHistoryReader.prototype.backwards;
  let failures = 1;
  t.mock.method(JsonlHistoryReader.prototype, "backwards", function (...args) {
    if (failures-- > 0) throw problem("History too large", 413);
    return backwards.apply(this, args);
  });
  const placeholder = await f.history.readPage(f.session, "native");
  assert.deepEqual(placeholder.messages, []);
  assert.equal(placeholder.indexing, true);
  assert.equal(placeholder.next, null);
  await f.indexed();
  const { first, messages } = await f.pages();
  assert.ok(first.next?.indexed, "served from the index");
  assert.equal(messages.length, 120);
});

test("an unmatched image source cannot make the provisional page read the whole file", async (t) => {
  const f = await claudeHistoryFixture(t);
  const pad = "ä".repeat(1000);
  await f.write([
    ...conversation(f, 2000).map((record) => ({
      ...record,
      message: {
        ...record.message,
        content:
          typeof record.message.content === "string"
            ? `${record.message.content} ${pad}`
            : [{ type: "text", text: `${record.message.content[0].text} ${pad}` }],
      },
    })),
    f.user("companion", [{ type: "text", text: "[Image: source: /tmp/fixture.png]" }], {
      isMeta: true,
      turnCompanion: true,
      promptId: "prompt-without-image",
    }),
    ...conversation(f, 10, "tail-"),
  ]);
  const counter = countReads(t);
  const page = await f.history.readPage(f.session, "native");
  assert.equal(page.messages.length, 50);
  assert.ok(counter.bytes < (await fs.stat(f.file)).size / 4, `${counter.bytes} bytes`);
});
