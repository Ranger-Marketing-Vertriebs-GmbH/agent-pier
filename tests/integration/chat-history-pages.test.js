import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatStore } from "../../server/features/chat/chat-store.js";
import { ProviderHistory } from "../../server/features/chat/provider-history.js";

function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-pages-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session = {
    id: "test",
    tool: "codex",
    accountId: "one",
    cwd: dataDir,
    status: "running",
  };
  const history = new ProviderHistory({
    home: dataDir,
    accounts: {
      get: () => ({ tool: "codex" }),
      environment: () => ({ HOME: dataDir }),
    },
  });
  const calls = [];
  history.codex = () => ({
    request: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") {
        assert.equal(params.includeTurns, false);
        return { thread: { cwd: dataDir, id: "native" } };
      }
      const end = params.cursor ? Number(params.cursor) : 1105;
      const start = Math.max(0, end - params.limit);
      return {
        data: Array.from({ length: end - start }, (_, i) => ({
          id: String(end - i - 1),
          items: [
            { id: `m${end - i - 1}`, type: "agentMessage", text: String(end - i - 1) },
          ],
        })),
        nextCursor: start ? String(start) : null,
      };
    },
  });
  const store = new ChatStore({
    dataDir,
    sessions: { get: async () => session },
    history,
    liveHistoryTimeout: 1,
    ...options,
  });
  store.initialize(session, "native");
  return { store, session, history, calls, dataDir };
}

test("native history starts bounded and pages all 1105 messages in chronological order", async (t) => {
  const { store, calls } = fixture(t);
  let result = await store.read("test");
  assert.equal(result.messages.length, 10);
  assert.equal(calls.length, 2);
  let messages = result.messages;
  while (result.history.cursor) {
    result = await store.older("test", result.history.cursor);
    messages = [...result.messages, ...messages];
  }
  assert.equal(messages.length, 1105);
  assert.equal(new Set(messages.map((m) => m.id)).size, 1105);
  assert.equal(messages[0].text, "0");
  assert.equal(messages.at(-1).text, "1104");
});

test("history cursors reject foreign sessions, changed accounts and removed bindings", async (t) => {
  const { store, session } = fixture(t);
  const {
    history: { cursor },
  } = await store.read("test");
  await assert.rejects(store.older("other", cursor), { status: 409 });
  session.accountId = "other";
  await assert.rejects(store.older("test", cursor), { status: 409 });
  session.accountId = "one";
  store.remove("test");
  await assert.rejects(store.older("test", cursor), { status: 409 });
});

test("slow reads remain single flight and cannot restore a removed snapshot", async (t) => {
  const { store, history, dataDir } = fixture(t);
  await store.read("test");
  store.cache.clear();
  let finish;
  let reads = 0;
  history.readPage = () => {
    reads++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  };
  await store.read("test");
  store.cache.get("test").time = 0;
  await store.read("test");
  assert.equal(reads, 1);
  store.remove("test");
  finish({ messages: [], tasks: [], next: null });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fs.existsSync(path.join(dataDir, "chat", "test.snapshot.json")), false);
});

test("a single oversized turn remains bounded without losing messages", async (t) => {
  const { store, history, session } = fixture(t);
  history.codex = () => ({
    request: async (method) =>
      method === "thread/read"
        ? { thread: { cwd: session.cwd } }
        : {
            data: [
              {
                id: "huge",
                items: Array.from({ length: 121 }, (_, i) => ({
                  id: `item${i}`,
                  type: "agentMessage",
                  text: String(i),
                })),
              },
            ],
            nextCursor: null,
          },
  });
  let result = await store.read("test");
  const firstCursor = result.history.cursor;
  store.invalidate("test");
  assert.equal((await store.read("test")).history.cursor, firstCursor);
  let messages = result.messages;
  assert.equal(messages.length, 50);
  while (result.history.cursor) {
    result = await store.older("test", result.history.cursor);
    assert.ok(result.messages.length <= 50);
    messages = [...result.messages, ...messages];
  }
  assert.deepEqual(
    messages.map((m) => m.text),
    Array.from({ length: 121 }, (_, i) => String(i)),
  );
});

test("same-thread reset changes generation and invalidates older pages", async (t) => {
  const { store } = fixture(t);
  const first = await store.read("test");
  store.reset("test");
  const next = await store.read("test");
  assert.notEqual(next.history.generation, first.history.generation);
  await assert.rejects(store.older("test", first.history.cursor), { status: 409 });
});

test("background completion publishes once and keeps the fresh snapshot cached", async (t) => {
  const { store, history } = fixture(t);
  await store.read("test");
  store.invalidate("test");
  let finish;
  history.readPage = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const events = [];
  store.events = { publish: (...args) => events.push(args) };
  await store.read("test");
  finish({ messages: [{ id: "fresh", text: "Fresh" }], tasks: [] });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.length, 1);
  assert.equal(events[0][1], "snapshot-changed");
  assert.equal((await store.read("test")).messages[0].text, "Fresh");
});

test("Claude and OpenCode pages use stable message boundaries while new messages append", async (t) => {
  const { history, session } = fixture(t);
  const messages = Array.from({ length: 123 }, (_, i) => ({
    id: `m${i}`,
    text: String(i),
  }));
  history.read = async () => ({ messages, tasks: [] });
  for (const tool of ["claude", "opencode"]) {
    session.tool = tool;
    history.environment = () => ({});
    const first = await history.readPage(session, "native");
    assert.equal(first.messages.length, 50);
    messages.push({ id: `m${messages.length}`, text: String(messages.length) });
    const second = await history.readPage(session, "native", first.next);
    assert.equal(
      second.messages.at(-1).id,
      `m${Number(first.messages[0].id.slice(1)) - 1}`,
    );
  }
});

test("an account switch during provider resolution cannot create an old binding", async (t) => {
  const { store, session, dataDir } = fixture(t);
  store.remove("test");
  let resolve;
  store.bindings = {
    resolve: () =>
      new Promise((done) => {
        resolve = done;
      }),
  };
  const pending = store.read("test");
  await new Promise((done) => setImmediate(done));
  session.accountId = "other";
  resolve({ id: "old-native", source: "native-process" });
  await assert.rejects(pending, { status: 409 });
  assert.equal(fs.existsSync(path.join(dataDir, "chat", "test.binding.json")), false);
});

test("restart fallback trims legacy snapshots and removes unusable history cursors", async (t) => {
  const { store, history, session, dataDir } = fixture(t);
  const initial = await store.read("test");
  const snapshotFile = path.join(dataDir, "chat", "test.snapshot.json");
  const saved = JSON.parse(fs.readFileSync(snapshotFile, "utf8"));
  saved.messages = Array.from({ length: 500 }, (_, i) => ({
    id: `old${i}`,
    text: String(i),
  }));
  fs.writeFileSync(snapshotFile, JSON.stringify(saved));
  history.readPage = async () => {
    throw Error("offline");
  };
  const restarted = new ChatStore({
    dataDir,
    sessions: { get: async () => session },
    history,
  });
  const fallback = await restarted.read("test");
  assert.equal(fallback.messages.length, 50);
  assert.equal(fallback.messages[0].text, "450");
  assert.equal(fallback.history.cursor, null);
  assert.notEqual(fallback.history.generation, initial.history.generation);
  assert.equal(fallback.scope, undefined);
});

test("older pages reject native clear and native replacement before a snapshot refresh", async (t) => {
  const { store, session, calls } = fixture(t);
  session.nativeBinding = { enabled: true };
  store.bindings = { resolve: async () => ({ id: "native", source: "native-process" }) };
  let first = await store.read("test");
  const before = calls.length;
  store.bindings.resolve = async () => ({ id: null, source: "native-process" });
  await assert.rejects(store.older("test", first.history.cursor), { status: 409 });
  assert.equal(calls.length, before);
  store.bindings.resolve = async () => ({ id: "native", source: "native-process" });
  first = await store.read("test");
  store.bindings.resolve = async () => ({ id: "replacement", source: "native-process" });
  await assert.rejects(store.older("test", first.history.cursor), { status: 409 });
});

test("persisted snapshots from a different account cannot be used as fallback", async (t) => {
  const { store, history, dataDir } = fixture(t);
  await store.read("test");
  store.invalidate("test");
  const file = path.join(dataDir, "chat", "test.snapshot.json");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.scope = { accountId: "different", tool: "codex" };
  fs.writeFileSync(file, JSON.stringify(saved));
  history.readPage = async () => {
    throw Error("offline");
  };
  await assert.rejects(store.read("test"), /offline/);
});

test("cursor memory budget evicts older pages and resets release accounting", async (t) => {
  const { store, session } = fixture(t, { maxCursorBytes: 1800 });
  const first = store.cursor(session, "native", { before: "a".repeat(400) });
  store.cursor(session, "native", { before: "b".repeat(400) });
  store.cursor(session, "native", { before: "c".repeat(400) });
  assert.ok(store.cursorBytes <= 1800);
  await assert.rejects(store.older("test", first), { status: 409 });
  store.reset("test");
  assert.equal(store.cursorBytes, 0);
  assert.equal(store.cursors.size, 0);
});

test("cursor entries are limited and oversized state fails explicitly", async (t) => {
  const { store, session } = fixture(t, { maxCursorEntries: 2, maxCursorBytes: 1800 });
  const first = store.cursor(session, "native", { before: "one" });
  store.cursor(session, "native", { before: "two" });
  const third = store.cursor(session, "native", { before: "three" });
  assert.equal(store.cursors.size, 2);
  assert.equal(store.cursors.get(third).signature.length, 64);
  await assert.rejects(store.older("test", first), { status: 409 });
  assert.throws(
    () => store.cursor(session, "native", { remaining: [{ text: "x".repeat(2000) }] }),
    { status: 413 },
  );
  assert.equal(store.cursors.size, 2);
});
