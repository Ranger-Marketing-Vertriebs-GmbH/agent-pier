import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ChatStore } from "../../server/features/chat/chat-store.js";
import { ChatStreams } from "../../server/features/chat/chat-streams.js";
import { ChatEvents } from "../../server/features/chat/chat-events.js";
import { watchNativeInput } from "../../server/features/chat/native-input-watch.js";
import { until } from "../helpers/adapter-process.js";

const NATIVE = "11111111-1111-1111-1111-111111111111";

function fixture(t, { readMs = 80, liveHistoryTimeout } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-fresh-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const session = {
    id: "s1",
    accountId: "a",
    tool: "claude",
    cwd: "/x",
    status: "running",
  };
  const source = { version: 1, reads: 0 };
  const history = {
    list: async () => [],
    // Like JsonlHistoryReader: content is fixed by the size seen when the read opens.
    readPage: async () => {
      const version = source.version;
      source.reads++;
      await delay(readMs);
      return {
        messages: [{ id: `m${version}`, role: "assistant", text: `v${version}` }],
        tasks: [],
      };
    },
  };
  const events = new ChatEvents();
  const published = [];
  const originalPublish = events.publish.bind(events);
  events.publish = (...args) => {
    published.push(args[1]);
    return originalPublish(...args);
  };
  const chat = new ChatStore({
    dataDir,
    sessions: { get: async () => ({ ...session }) },
    history,
    events,
    ...(liveHistoryTimeout ? { liveHistoryTimeout } : {}),
  });
  chat.initialize(session, NATIVE, "manual");
  published.length = 0;
  return { chat, events, session, source, published };
}

const ids = (snapshot) => snapshot.messages.map((message) => message.id);

test("a source invalidation never joins a read opened before the change", async (t) => {
  const f = fixture(t);
  const before = f.chat.read("s1");
  await delay(10);
  f.source.version = 2;
  f.chat.invalidate("s1");
  const after = await f.chat.read("s1");
  assert.deepEqual(ids(after), ["m2"]);
  assert.deepEqual(ids(await before), ["m1"]);
  assert.deepEqual(ids(await f.chat.read("s1")), ["m2"], "stale read was not cached");
});

test("a timed-out read superseded by a source change neither caches nor announces itself", async (t) => {
  const f = fixture(t, { readMs: 60, liveHistoryTimeout: 5 });
  await f.chat.read("s1"); // saved snapshot
  f.chat.invalidate("s1");
  const stale = await f.chat.read("s1");
  assert.equal(stale.notice !== undefined, true, "timed out to the saved snapshot");
  f.source.version = 2;
  f.chat.invalidate("s1");
  await delay(100);
  assert.ok(!f.published.includes("snapshot-changed"));
  assert.equal(f.chat.cache.has("s1"), false);
});

function streams(f, options = {}) {
  let changed;
  const value = new ChatStreams({
    sessions: { get: async () => ({ ...f.session }), tmuxPath: "/fixture/tmux" },
    chat: f.chat,
    chatImages: { read: (id) => f.chat.read(id) },
    chatEvents: f.events,
    accounts: {},
    config: {},
    watch: (_options, callback) => {
      changed = callback;
      return () => {};
    },
    watchInput: () => () => {},
    debounceMs: 5,
    ...options,
  });
  return { streams: value, changed: () => changed() };
}

test("a new subscriber gets the cached value and then the current source", async (t) => {
  const f = fixture(t, { readMs: 5 });
  const s = streams(f);
  t.after(() => s.streams.close());
  const first = [];
  s.streams.subscribe("s1", (value) => first.push(value));
  // Wait for the settled first read; a slow runner may need far longer than 100 ms.
  await until(() => first.length && !s.streams.entries.get("s1").pending, 10_000);
  assert.deepEqual(ids(first.at(-1).snapshot), ["m1"]);
  f.source.version = 2; // written without a delivered watcher event
  const second = [];
  s.streams.subscribe("s1", (value) => second.push(value));
  // Only the new subscriber's refresh can read version 2, so this never passes
  // without it; the deadline only absorbs a slow runner.
  await until(() => second.at(-1)?.snapshot.messages[0]?.id === "m2", 10_000);
  assert.deepEqual(ids(second[0].snapshot), ["m1"]);
  assert.deepEqual(ids(second.at(-1).snapshot), ["m2"]);
  assert.deepEqual(ids(first.at(-1).snapshot), ["m2"]);
});

test("recovery refreshes history without restarting healthy source or input watchers", async (t) => {
  const f = fixture(t, { readMs: 1 });
  let observers = 0,
    sourceWatchers = 0,
    closed = 0,
    queue = ["q"];
  const s = streams(f, {
    recoveryMs: 40,
    watch: () => {
      sourceWatchers++;
      return () => closed++;
    },
    watchInput: (_options, changed) => {
      observers++;
      changed({ generation: 1, queue });
      const stop = () => closed++;
      stop.refresh = () => changed({ generation: 1, queue });
      return stop;
    },
  });
  t.after(() => s.streams.close());
  const values = [];
  const stop = s.streams.subscribe("s1", (value) => values.push(value));
  await until(() => values.at(-1)?.snapshot?.nativeInput, 10_000);
  const reads = f.source.reads;
  f.source.version = 2;
  queue = ["recovered"];
  await until(() => f.source.reads >= reads + 3, 10_000);
  assert.deepEqual(ids(values.at(-1).snapshot), ["m2"], "recovery still reads history");
  assert.deepEqual(values.at(-1).snapshot.nativeInput.queue, ["recovered"]);
  assert.equal(sourceWatchers, 1, "no repeated filesystem registration");
  assert.equal(observers, 1, "no repeated tmux attachment");
  assert.equal(closed, 0);
  stop();
  assert.equal(closed, 2, "last viewer releases both observers");
});

test("an exited native observer is reattached without waiting for recovery", async (t) => {
  const f = fixture(t, { readMs: 1 });
  const exits = [];
  const s = streams(f, {
    recoveryMs: 60000,
    watchInput: ({ onExit }) => {
      exits.push(onExit);
      return () => {};
    },
  });
  t.after(() => s.streams.close());
  s.streams.subscribe("s1", () => {});
  await until(() => exits.length === 1, 10_000);
  exits[0]();
  // The reattach backs off for 1 s; recovery (60 s) is far beyond this deadline.
  await until(() => exits.length === 2, 10_000);
  assert.equal(exits.length, 2);
});

test("the native observer reports a lost tmux control client", async () => {
  let exited = 0;
  const values = [];
  watchNativeInput(
    {
      sessions: {
        tmuxPath: "/usr/bin/false",
        socketPath: "/nonexistent/socket",
        configPath: "/dev/null",
        target: (id) => `fixture-${id}`,
        get: async () => ({ status: "ended" }),
      },
      session: { id: "s1", accountId: "a", tool: "claude" },
      onExit: () => exited++,
    },
    (value) => values.push(value),
  );
  const end = Date.now() + 5000;
  while (!exited && Date.now() < end) await delay(10);
  await delay(50);
  assert.equal(exited, 1);
  assert.deepEqual(values, [null]);
});

test("history cursors are evicted least recently used", async (t) => {
  const f = fixture(t);
  f.chat.maxCursorEntries = 2;
  const first = f.chat.cursor(f.session, NATIVE, { page: 1 });
  const second = f.chat.cursor(f.session, NATIVE, { page: 2 });
  assert.equal(f.chat.cursor(f.session, NATIVE, { page: 1 }), first);
  f.chat.cursor(f.session, NATIVE, { page: 3 });
  assert.ok(f.chat.cursors.has(first), "recently used cursor survives");
  assert.ok(!f.chat.cursors.has(second));
  f.chat.cursor(f.session, NATIVE, { page: 4 });
  assert.ok(!f.chat.cursors.has(first));
});
