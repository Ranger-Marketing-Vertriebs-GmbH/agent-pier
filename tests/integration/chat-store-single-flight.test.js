import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChatStore } from "../../server/features/chat/chat-store.js";

const NATIVE = "11111111-1111-1111-1111-111111111111";

function fixture(t, { readMs, liveHistoryTimeout = 50, page } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-flight-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session = {
    id: "s1",
    accountId: "a",
    tool: "claude",
    cwd: "/x",
    status: "running",
  };
  const source = { version: 1, reads: 0, active: 0, peak: 0 };
  const history = {
    list: async () => [],
    readPage: async () => {
      const version = source.version;
      source.reads++;
      source.peak = Math.max(source.peak, ++source.active);
      try {
        await delay(readMs);
        return page
          ? page(version)
          : {
              messages: [{ id: `m${version}`, role: "assistant", text: `v${version}` }],
              tasks: [],
            };
      } finally {
        source.active--;
      }
    },
  };
  const published = [];
  const chat = new ChatStore({
    dataDir,
    sessions: { get: async () => ({ ...session }) },
    history,
    events: { publish: (...args) => published.push(args[1]) },
    liveHistoryTimeout,
  });
  chat.initialize(session, NATIVE, "manual");
  published.length = 0;
  const saved = () =>
    JSON.parse(fs.readFileSync(chat.file("s1", "snapshot"), "utf8")).messages.map(
      (message) => message.id,
    );
  return { chat, source, session, published, saved };
}

test("source changes during slow reads queue one follow-up instead of parallel reads", async (t) => {
  const f = fixture(t, { readMs: 400 });
  await f.chat.read("s1");
  const reads = [];
  for (let change = 0; change < 20; change++) {
    f.source.version++;
    f.chat.invalidate("s1");
    reads.push(f.chat.read("s1"));
    await delay(60);
  }
  await Promise.all(reads);
  await delay(900);
  assert.equal(f.source.peak, 1, "never more than one provider read at a time");
  assert.ok(f.source.reads <= 6, `${f.source.reads} reads`);
  assert.deepEqual(f.saved(), [`m${f.source.version}`], "newest source is saved last");
  assert.deepEqual(
    (await f.chat.read("s1")).messages.map((message) => message.id),
    [`m${f.source.version}`],
  );
});

test("an indexing placeholder never replaces a saved transcript", async (t) => {
  let placeholder = false;
  const f = fixture(t, {
    readMs: 1,
    liveHistoryTimeout: 1000,
    page: (version) =>
      placeholder
        ? { messages: [], tasks: [], indexing: true, next: null }
        : {
            messages: [{ id: `m${version}`, role: "assistant", text: "saved" }],
            tasks: [],
          },
  });
  await f.chat.read("s1");
  placeholder = true;
  f.chat.invalidate("s1");
  const during = await f.chat.read("s1");
  assert.deepEqual(
    during.messages.map((message) => message.id),
    ["m1"],
  );
  assert.equal(during.history.indexing, true);
  assert.deepEqual(f.saved(), ["m1"]);
  f.chat.remove("s1");
  assert.equal(f.chat.epochs.has("s1"), false);
});

test("without a saved transcript the indexing placeholder is shown but not saved", async (t) => {
  const f = fixture(t, {
    readMs: 1,
    page: () => ({ messages: [], tasks: [], indexing: true, next: null }),
  });
  const result = await f.chat.read("s1");
  assert.deepEqual(result.messages, []);
  assert.equal(result.history.indexing, true);
  assert.equal(fs.existsSync(f.chat.file("s1", "snapshot")), false);
});
