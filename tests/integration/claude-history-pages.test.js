import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";

async function fixture(t, count = 1000) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "claude-pages-"));
  const session = { id: "fixture", accountId: "one", tool: "claude", cwd: home };
  const history = new ProviderHistory({
    home,
    accounts: {
      get: () => ({ tool: "claude" }),
      environment: () => ({ HOME: home }),
    },
  });
  t.after(async () => {
    await history.close();
    await fs.rm(home, { recursive: true, force: true });
  });
  const directory = path.join(
    home,
    ".claude/projects",
    home.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "native.jsonl");
  const record = (index, extra = {}) => ({
    uuid: `r${index}`,
    sessionId: "native",
    cwd: home,
    type: index % 2 ? "assistant" : "user",
    message: { content: `${index}: ${"ä".repeat(1000)}` },
    ...extra,
  });
  await fs.writeFile(
    file,
    Array.from({ length: count }, (_, i) => JSON.stringify(record(i)) + "\n").join(""),
  );
  return { history, session, file, record };
}

test("Claude pages seek native bytes and reproduce the full transcript without full reads", async (t) => {
  const f = await fixture(t);
  const full = await f.history.read(f.session, "native");
  f.history.read = () => {
    throw new Error("Full history must not be read");
  };
  let bytes = 0;
  const open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args);
    const read = handle.read.bind(handle);
    handle.read = async (...values) => {
      const result = await read(...values);
      bytes += result.bytesRead;
      return result;
    };
    return handle;
  });
  let page = await f.history.readPage(f.session, "native");
  assert.equal(page.messages.length, 50);
  assert.ok(
    bytes < (await fs.stat(f.file)).size / 4,
    `Only ${bytes} bytes should be read`,
  );
  const newest = page.messages;
  let all = newest;
  while (page.next) {
    page = await f.history.readPage(f.session, "native", page.next);
    assert.ok(page.messages.length <= 50);
    all = [...page.messages, ...all];
  }
  assert.deepEqual(all, full.messages);
});

test("Claude cursors survive append but reject truncation and file replacement", async (t) => {
  const f = await fixture(t, 120);
  const page = await f.history.readPage(f.session, "native");
  await fs.appendFile(f.file, JSON.stringify(f.record(120)) + "\n");
  const older = await f.history.readPage(f.session, "native", page.next);
  assert.equal(older.messages.at(-1).id, "r69");
  await fs.truncate(f.file, 0);
  await assert.rejects(f.history.readPage(f.session, "native", page.next), {
    status: 409,
  });
  await fs.writeFile(f.file + ".new", JSON.stringify(f.record(0)) + "\n");
  await fs.rename(f.file + ".new", f.file);
  await assert.rejects(f.history.readPage(f.session, "native", page.next), {
    status: 409,
  });
});

test("Claude ignores partial appends and keeps anonymous record IDs stable", async (t) => {
  const f = await fixture(t, 80);
  await fs.appendFile(
    f.file,
    JSON.stringify(f.record(80, { uuid: undefined })) + "\n" + '{"unfinished":',
  );
  const before = await f.history.readPage(f.session, "native");
  assert.match(before.messages.at(-1).id, /^claude-byte:/);
  await fs.appendFile(f.file, "true}\n" + JSON.stringify(f.record(81)) + "\n");
  const after = await f.history.readPage(f.session, "native");
  assert.ok(after.messages.some((row) => row.id === before.messages.at(-1).id));
});

test("Claude multipart snapshots and tool results stay coherent across pages", async (t) => {
  const f = await fixture(t, 2);
  const records = [
    f.record(2, {
      type: "assistant",
      message: {
        id: "multipart",
        content: Array.from({ length: 120 }, (_, i) => ({
          type: "text",
          text: `Part ${i}`,
        })),
      },
    }),
    f.record(3, {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "call", name: "Read", input: { file: "example" } },
        ],
      },
    }),
    f.record(4, {
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "call", content: "result" }],
      },
    }),
  ];
  await fs.appendFile(f.file, records.map((r) => JSON.stringify(r) + "\n").join(""));
  const full = await f.history.read(f.session, "native");
  let page = await f.history.readPage(f.session, "native");
  const cursor = page.next;
  let all = page.messages;
  while (page.next) {
    page = await f.history.readPage(f.session, "native", page.next);
    all = [...page.messages, ...all];
  }
  assert.deepEqual(all, full.messages);
  await fs.truncate(f.file, 0);
  await assert.rejects(f.history.readPage(f.session, "native", cursor), { status: 409 });
});

test("Claude skips malformed/non-record lines and reaches the beginning after blank prefixes", async (t) => {
  const f = await fixture(t, 80);
  const source = await fs.readFile(f.file, "utf8");
  await fs.writeFile(f.file, '\ninvalid\nnull\n123\n"text"\n[]\n' + source);
  let page = await f.history.readPage(f.session, "native");
  let count = page.messages.length,
    pages = 1;
  while (page.next) {
    assert.ok(++pages < 5, "pagination must terminate");
    page = await f.history.readPage(f.session, "native", page.next);
    count += page.messages.length;
  }
  assert.equal(count, 80);
});

test("Claude cursor anchors reject in-place rewrites and foreign project metadata", async (t) => {
  const f = await fixture(t, 80);
  const page = await f.history.readPage(f.session, "native");
  const handle = await fs.open(f.file, "r+");
  await handle.write(Buffer.from("x"), 0, 1, (await handle.stat()).size - 3);
  await handle.close();
  await assert.rejects(f.history.readPage(f.session, "native", page.next), {
    status: 409,
  });
  await fs.writeFile(f.file, JSON.stringify(f.record(0, { cwd: "/foreign" })) + "\n");
  await assert.rejects(f.history.readPage(f.session, "native"), { status: 409 });
});

async function indexed(f) {
  await new Promise((resolve) => setImmediate(resolve));
  const entry = f.history.claudePages.entries.get(f.session.id);
  await entry.pending;
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(entry.identity, "background index completed");
  return entry;
}

test("Claude background index preserves earlier tasks and interleaved fragments", async (t) => {
  const f = await fixture(t, 0);
  const records = [
    f.record(0, {
      type: "assistant",
      message: { id: "a", content: [{ type: "text", text: "partial" }] },
    }),
    f.record(1, {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "todo",
            name: "TodoWrite",
            input: { todos: [{ content: "Keep task", status: "in_progress" }] },
          },
        ],
      },
    }),
    f.record(2, {
      type: "assistant",
      message: { id: "a", content: [{ type: "text", text: "complete" }] },
    }),
    ...Array.from({ length: 100 }, (_, i) => f.record(i + 3)),
  ];
  await fs.writeFile(
    f.file,
    records.map((record) => JSON.stringify(record) + "\n").join(""),
  );
  const full = await f.history.read(f.session, "native");
  await f.history.readPage(f.session, "native");
  await indexed(f);
  let page = await f.history.readPage(f.session, "native");
  assert.deepEqual(page.tasks, full.tasks);
  assert.equal(page.observability.stale, false);
  assert.ok(page.next.indexed);
  let all = page.messages;
  while (page.next) {
    page = await f.history.readPage(f.session, "native", page.next);
    all = [...page.messages, ...all];
  }
  assert.deepEqual(all, full.messages);
});

test("Claude orphan tool results cannot make the provisional tail scan the entire file", async (t) => {
  const f = await fixture(t, 2000);
  await fs.appendFile(
    f.file,
    JSON.stringify(
      f.record(2000, {
        message: {
          content: [{ type: "tool_result", tool_use_id: "missing", content: "orphan" }],
        },
      }),
    ) + "\n",
  );
  let bytes = 0;
  const open = fs.open;
  t.mock.method(fs, "open", async (...args) => {
    const handle = await open(...args),
      read = handle.read.bind(handle);
    handle.read = async (...values) => {
      const result = await read(...values);
      bytes += result.bytesRead;
      return result;
    };
    return handle;
  });
  const page = await f.history.readPage(f.session, "native");
  assert.equal(page.messages.length, 50);
  assert.ok(bytes < (await fs.stat(f.file)).size / 4);
});

test("Claude indexed pages survive append and stream a new generation when indexing completes", async (t) => {
  const { ChatStore } = await import("../../server/features/chat/chat-store.js");
  const f = await fixture(t, 120);
  f.session.status = "running";
  const events = [];
  const store = new ChatStore({
    dataDir: path.join(f.session.cwd, "pier"),
    sessions: { get: async () => f.session },
    history: f.history,
    events: { publish: (...args) => events.push(args) },
  });
  store.initialize(f.session, "native");
  const initial = await store.read(f.session.id);
  await indexed(f);
  const ready = await store.read(f.session.id);
  assert.notEqual(ready.history.generation, initial.history.generation);
  assert.ok(events.some((event) => event[1] === "binding-changed"));
  await assert.rejects(store.older(f.session.id, initial.history.cursor), {
    status: 409,
  });
  await fs.appendFile(f.file, JSON.stringify(f.record(120)) + "\n");
  const older = await store.older(f.session.id, ready.history.cursor);
  assert.equal(older.messages.at(-1).id, "r69");
  store.invalidate(f.session.id);
  await store.read(f.session.id);
  await indexed(f);
  const updated = await store.read(f.session.id);
  assert.equal(updated.history.generation, ready.history.generation);
  assert.equal(updated.messages.at(-1).id, "r120");
});

test("Claude edit structure survives provisional pages, indexing and result append", async (t) => {
  const f = await fixture(t, 120);
  const call = f.record(120, {
    type: "assistant",
    message: {
      content: [
        {
          type: "tool_use",
          id: "edit-diff",
          name: "Edit",
          input: {
            file_path: "x.ts",
            old_string: "const a = 1;",
            new_string: "const a = 2;",
          },
        },
      ],
    },
  });
  await fs.appendFile(f.file, JSON.stringify(call) + "\n");
  const first = await f.history.readPage(f.session, "native");
  const expected = first.messages.find((m) => m.id === "edit-diff");
  assert.equal(expected.fileChanges[0].added, 1);
  assert.equal(expected.status, "running");
  const entry = f.history.claudePages?.entries?.get(f.session.id);
  if (entry?.index.job) await entry.index.job;
  const indexed = await f.history.readPage(f.session, "native");
  assert.deepEqual(
    indexed.messages.find((m) => m.id === "edit-diff"),
    expected,
  );
  await fs.appendFile(
    f.file,
    JSON.stringify(
      f.record(121, {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "edit-diff", content: "Done" }],
        },
      }),
    ) + "\n",
  );
  const updated = await f.history.readPage(f.session, "native");
  const completed = updated.messages.find((m) => m.id === "edit-diff");
  assert.equal(completed.status, "completed");
  assert.deepEqual(completed.fileChanges, expected.fileChanges);
  const reloaded = await f.history.read(f.session, "native");
  assert.deepEqual(
    reloaded.messages.find((m) => m.id === "edit-diff").fileChanges,
    expected.fileChanges,
  );
});
