import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ClaudeHistoryIndex } from "../../server/features/chat/claude-history-index.js";
import { JsonlHistoryReader } from "../../server/features/chat/jsonl-history-reader.js";
import { normalizeClaude } from "../../server/features/chat/history-parsers.js";

async function fixture(t, records) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "claude-index-"));
  const file = path.join(directory, "source.jsonl");
  await fs.writeFile(file, records.map((r) => JSON.stringify(r) + "\n").join(""));
  const events = [],
    batches = [];
  const index = new ClaudeHistoryIndex({
    file,
    directory,
    onReady: (event) => events.push(event),
    onRecords: (rows) => batches.push(...rows),
  });
  t.after(async () => {
    await index.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const identity = async () => {
    const reader = await JsonlHistoryReader.open(file);
    try {
      return reader.identity;
    } finally {
      await reader.close();
    }
  };
  return { index, identity, events, batches, file, directory };
}
const message = (id, text) => ({
  type: "assistant",
  uuid: id,
  message: { id, content: [{ type: "text", text }] },
});

test("index joins interleaved fragments and pages by first occurrence without retaining bodies", async (t) => {
  const records = [
    message("early", "old"),
    ...Array.from({ length: 60 }, (_, i) => message(`m${i}`, String(i))),
    message("early", "final secret phrase"),
  ];
  const f = await fixture(t, records);
  const identity = await f.identity();
  assert.equal(f.index.ready(identity), false);
  await f.index.refresh(identity);
  assert.equal(f.index.ready(identity), true);
  let page = await f.index.page({ identity, limit: 50 });
  let all = normalizeClaude(page.records).messages;
  assert.equal(all.length, 50);
  assert.equal(
    all.some((r) => r.id.startsWith("early")),
    false,
  );
  while (page.nextBefore !== null) {
    page = await f.index.page({
      identity,
      before: page.nextBefore,
      generation: page.generation,
      limit: 50,
    });
    all = [...normalizeClaude(page.records).messages, ...all];
  }
  assert.deepEqual(all, normalizeClaude(records).messages);
  const db = await fs.readFile(f.index.databasePath);
  assert.equal(db.includes(Buffer.from("final secret phrase")), false);
  assert.equal((await fs.stat(f.index.databasePath)).mode & 0o777, 0o600);
});

test("append scanning is incremental and old identities exclude newly appended fragments", async (t) => {
  const f = await fixture(t, [message("old", "initial"), message("new", "tail")]);
  const first = await f.identity();
  await f.index.refresh(first);
  const beforeBytes = f.index.readBytes;
  const line = JSON.stringify(message("old", "updated")) + "\n";
  await fs.appendFile(f.file, line);
  const second = await f.identity();
  await f.index.refresh(second);
  assert.ok(f.index.readBytes - beforeBytes <= Buffer.byteLength(line));
  assert.equal(f.batches.length, 3);
  assert.equal(
    normalizeClaude((await f.index.page({ identity: first })).records).messages[0].text,
    "initial",
  );
  assert.equal(
    normalizeClaude((await f.index.page({ identity: second })).records).messages[0].text,
    "updated",
  );
});

test("tool results outside a selected page hydrate their calls without duplicate result groups", async (t) => {
  const call = {
    type: "assistant",
    uuid: "call",
    message: {
      content: [
        { type: "tool_use", id: "tool1", name: "Bash", input: { command: "true" } },
      ],
    },
  };
  const result = {
    type: "user",
    uuid: "result",
    message: {
      content: [{ type: "tool_result", tool_use_id: "tool1", content: "done" }],
    },
  };
  const records = [
    call,
    ...Array.from({ length: 60 }, (_, i) => message(`m${i}`, String(i))),
    result,
  ];
  const f = await fixture(t, records);
  const identity = await f.identity();
  await f.index.refresh(identity);
  const newest = await f.index.page({ identity });
  assert.equal(normalizeClaude(newest.records).messages.length, 50);
  const older = await f.index.page({ identity, before: newest.nextBefore });
  const normalized = normalizeClaude(older.records).messages;
  assert.equal(normalized[0].id, "tool1");
  assert.equal(normalized[0].status, "completed");
  assert.match(normalized[0].text, /done/);
  assert.equal(normalized.length, 11);
});

test("initial indexing yields between source blocks and rebuild invalidates generations", async (t) => {
  const f = await fixture(
    t,
    Array.from({ length: 300 }, (_, i) => message(`m${i}`, "x".repeat(1000))),
  );
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  t.after(() => clearInterval(timer));
  const first = await f.identity();
  const pending = f.index.refresh(first);
  assert.equal(await f.index.page({ identity: first }), null);
  await pending;
  assert.ok(ticks > 1);
  const page = await f.index.page({ identity: first });
  await fs.writeFile(f.file, JSON.stringify(message("replacement", "changed")) + "\n");
  const second = await f.identity();
  await f.index.refresh(second);
  assert.notEqual(f.index.generation, page.generation);
  await assert.rejects(f.index.page({ identity: second, generation: page.generation }), {
    status: 409,
  });
  assert.equal(
    normalizeClaude((await f.index.page({ identity: second })).records).messages[0].text,
    "changed",
  );
});

test("older indexed cutoffs remain readable while append scanning is active", async (t) => {
  const f = await fixture(t, [message("old", "before")]);
  const first = await f.identity();
  await f.index.refresh(first);
  let during;
  f.index.onRecords = () => {
    if (!during) {
      assert.equal(f.index.scanning, true);
      assert.equal(f.index.ready(first), true);
      during = f.index.page({ identity: first, generation: f.index.generation });
    }
  };
  await fs.appendFile(
    f.file,
    Array.from(
      { length: 300 },
      (_, i) => JSON.stringify(message(`new${i}`, "x".repeat(1000))) + "\n",
    ).join(""),
  );
  await f.index.refresh(await f.identity());
  assert.deepEqual(
    normalizeClaude((await during).records).messages.map((m) => m.text),
    ["before"],
  );
});

test("mixed orphan and matched tool results never introduce another page's call", async (t) => {
  const call = {
    type: "assistant",
    uuid: "call",
    message: { content: [{ type: "tool_use", id: "matched", name: "Bash", input: {} }] },
  };
  const result = {
    type: "user",
    uuid: "result",
    message: {
      content: [
        { type: "tool_result", tool_use_id: "matched", content: "matched output" },
        { type: "tool_result", tool_use_id: "orphan", content: "orphan output" },
      ],
    },
  };
  const records = [
    call,
    ...Array.from({ length: 60 }, (_, i) => message(`m${i}`, String(i))),
    result,
  ];
  const f = await fixture(t, records);
  const identity = await f.identity();
  await f.index.refresh(identity);
  const newest = await f.index.page({ identity });
  let all = normalizeClaude(newest.records).messages;
  assert.equal(
    all.some((m) => m.id === "matched"),
    false,
  );
  const older = await f.index.page({ identity, before: newest.nextBefore });
  all = [...normalizeClaude(older.records).messages, ...all];
  assert.deepEqual(all, normalizeClaude(records).messages);
});

test("partial final records enter the index exactly once after completion", async (t) => {
  const f = await fixture(t, [message("first", "one")]);
  const second = JSON.stringify(message("second", "two"));
  await fs.appendFile(f.file, second.slice(0, 20));
  await f.index.refresh(await f.identity());
  assert.equal(f.batches.length, 1);
  await fs.appendFile(f.file, second.slice(20) + "\n");
  const identity = await f.identity();
  await f.index.refresh(identity);
  assert.equal(f.batches.length, 2);
  assert.deepEqual(
    normalizeClaude((await f.index.page({ identity })).records).messages.map(
      (m) => m.text,
    ),
    ["one", "two"],
  );
});

test("same-size source rewrites rebuild and disposable storage is removed on close", async (t) => {
  const f = await fixture(t, [message("first", "one")]);
  const initial = await f.identity();
  await f.index.refresh(initial);
  const generation = f.index.generation;
  await fs.writeFile(f.file, JSON.stringify(message("first", "two")) + "\n");
  const info = await fs.stat(f.file);
  await fs.utimes(f.file, info.atime, new Date(initial.mtime + 1000));
  const identity = await f.identity();
  await f.index.refresh(identity);
  assert.notEqual(f.index.generation, generation);
  assert.equal(
    normalizeClaude((await f.index.page({ identity })).records).messages[0].text,
    "two",
  );
  const directory = f.index.directory;
  await f.index.close();
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});
