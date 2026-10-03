import test from "node:test";
import assert from "node:assert/strict";
import { createChatStream } from "../../web/features/chat/chat-stream-transport.js";
import { setLanguage } from "../../web/lib/i18n/index.js";

const row = (id, text = id) => ({ id, text });
const baseline = (cursor = "c1") => ({
  messages: [row("a")],
  providerSessionId: "one",
  sync: { mode: "full", cursor },
});
const delta = (base, cursor, upserts = [row("b")]) => ({
  providerSessionId: "one",
  metadata: { providerSessionId: "one" },
  sync: { mode: "delta", base, cursor },
  upserts,
  order: ["a", ...upserts.map((m) => m.id)],
  removed: [],
});

function fixture({ initial, read = async () => baseline("fresh") } = {}) {
  const timers = new Map();
  const urls = [];
  const sockets = [];
  const snapshots = [];
  const connections = [];
  const readCursors = [];
  const errors = [];
  let listener;
  const visibility = {
    hidden: false,
    addEventListener: (_, fn) => (listener = fn),
    removeEventListener: () => (listener = null),
  };
  const dispose = createChatStream({
    url: "ws://fixture/chat-stream",
    initial,
    read: (signal, cursor) => {
      readCursors.push(cursor);
      return read(signal, cursor);
    },
    onSnapshot: (value) => snapshots.push(value),
    onConnection: (value) => connections.push(value),
    onError: (value) => errors.push(value),
    visibility,
    schedule: (fn, delay) => {
      const id = Symbol();
      timers.set(id, { fn, delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
    createSocket: (address) => {
      urls.push(address);
      const socket = { close() {} };
      sockets.push(socket);
      return socket;
    },
  });
  return {
    urls,
    sockets,
    snapshots,
    connections,
    readCursors,
    errors,
    dispose,
    open: () => sockets.at(-1).onopen(),
    send: (data) => sockets.at(-1).onmessage({ data: JSON.stringify(data) }),
    fail: () => sockets.at(-1).onerror(),
    tick() {
      const [id, timer] = [...timers].sort((a, b) => a[1].delay - b[1].delay)[0];
      timers.delete(id);
      timer.fn();
    },
    visible(hidden) {
      visibility.hidden = hidden;
      listener();
    },
  };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const sync = (data, sequence = 1) => ({ type: "sync", sequence, data });
const ids = (value) => value.messages.map((m) => m.id);

test("a seeded baseline puts its cursor on the first socket URL", () => {
  const f = fixture({ initial: baseline() });
  assert.equal(f.urls[0], "ws://fixture/chat-stream?cursor=c1");
  f.dispose();
});

test("a delta first frame applies to the baseline and the next reconnect uses the new cursor", () => {
  const f = fixture({ initial: baseline() });
  f.open();
  f.send(sync(delta("c1", "c2")));
  assert.deepEqual(ids(f.snapshots[0]), ["a", "b"]);
  f.fail();
  f.tick();
  assert.equal(f.urls[1], "ws://fixture/chat-stream?cursor=c2");
  f.dispose();
});

test("an invalid delta drops the cursor so the reconnect starts without one", () => {
  const f = fixture({ initial: baseline() });
  f.open();
  f.send(sync(delta("other", "c2")));
  assert.equal(f.snapshots.length, 0);
  f.tick();
  assert.equal(f.urls[1], "ws://fixture/chat-stream");
  f.dispose();
});

test("the fallback read receives the baseline cursor and applies a delta", async () => {
  const f = fixture({ initial: baseline(), read: async () => delta("c1", "c2") });
  f.fail();
  await settle();
  assert.deepEqual(f.readCursors, ["c1"]);
  assert.deepEqual(ids(f.snapshots[0]), ["a", "b"]);
  f.dispose();
});

test("an invalid fallback delta drops the baseline cursor", async () => {
  const f = fixture({ initial: baseline(), read: async () => delta("zz", "c2") });
  f.fail();
  await settle();
  assert.equal(f.snapshots.length, 0);
  f.tick();
  assert.equal(f.urls[1], "ws://fixture/chat-stream");
  f.dispose();
});

test("connected is reported only after the first accepted frame", () => {
  const f = fixture();
  assert.deepEqual(f.connections, ["disconnected"]);
  f.open();
  assert.deepEqual(f.connections, ["disconnected", "connecting"]);
  f.send({ type: "snapshot", sequence: 1, snapshot: baseline() });
  assert.deepEqual(f.connections, ["disconnected", "connecting", "connected"]);
  f.send({ type: "snapshot", sequence: 2, snapshot: baseline("c2") });
  assert.equal(f.connections.filter((value) => value === "connected").length, 1);
  f.dispose();
});

test("a socket that opens and closes without a frame never reports connected", () => {
  const f = fixture();
  f.open();
  f.sockets.at(-1).onclose();
  assert.ok(!f.connections.includes("connected"));
  f.dispose();
});

test("a fallback success without an open socket keeps the socket's state", async () => {
  const f = fixture();
  f.fail();
  await settle();
  assert.equal(f.snapshots.length, 1);
  assert.ok(!f.connections.includes("connected"));
  assert.equal(f.connections.at(-1), "disconnected");
  f.dispose();
});

test("a rejected fallback delta reports translated copy, never the raw error", async (t) => {
  t.after(() => setLanguage("de", { persist: false }));
  setLanguage("en", { persist: false });
  const f = fixture({ initial: baseline(), read: async () => delta("zz", "c2") });
  f.fail();
  await settle();
  assert.equal(f.snapshots.length, 0);
  assert.equal(f.errors.at(-1), "The chat could not be loaded completely. Retrying…");
  assert.ok(!f.errors.includes("Invalid chat delta"));
  f.tick();
  assert.equal(f.urls[1], "ws://fixture/chat-stream");
  f.dispose();
});

test("a fallback landing while a socket is open leaves the state to the socket", async () => {
  let release;
  const f = fixture({
    read: () => new Promise((resolve) => (release = () => resolve(baseline("x")))),
  });
  f.fail();
  f.tick();
  f.open();
  release();
  await settle();
  assert.equal(f.snapshots.length, 1);
  assert.equal(f.connections.at(-1), "connecting");
  f.dispose();
});

test("a visibility reconnect uses the latest cursor", () => {
  const f = fixture({ initial: baseline() });
  f.open();
  f.send(sync(delta("c1", "c2")));
  f.visible(true);
  f.visible(false);
  assert.equal(f.urls.at(-1), "ws://fixture/chat-stream?cursor=c2");
  f.dispose();
});

test("an initial snapshot without a cursor behaves like no baseline", () => {
  const f = fixture({ initial: { messages: [row("a")], providerSessionId: "one" } });
  assert.equal(f.urls[0], "ws://fixture/chat-stream");
  f.dispose();
});
