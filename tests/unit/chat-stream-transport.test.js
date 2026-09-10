import test from "node:test";
import assert from "node:assert/strict";
import { chatWindowPrefix } from "../../web/features/chat/chat-sync.js";
import { createChatStream } from "../../web/features/chat/chat-stream-transport.js";

function fixture(read = async () => ({ messages: [], providerSessionId: "one" })) {
  const timers = new Map();
  const sockets = [];
  const snapshots = [];
  const errors = [];
  const connections = [];
  let reads = 0;
  let listener;
  const visibility = {
    hidden: false,
    addEventListener: (_, fn) => {
      listener = fn;
    },
    removeEventListener: () => {
      listener = null;
    },
  };
  const dispose = createChatStream({
    url: "ws://fixture/chat-stream",
    read: (signal) => {
      reads++;
      return read(signal);
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
    createSocket: () => {
      const socket = {
        close() {
          this.closed = true;
        },
      };
      sockets.push(socket);
      return socket;
    },
  });
  return {
    sockets,
    snapshots,
    errors,
    connections,
    timers,
    dispose,
    get reads() {
      return reads;
    },
    send(data) {
      sockets.at(-1).onmessage({ data: JSON.stringify(data) });
    },
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
const snapshot = (sequence, text = "First") => ({
  type: "snapshot",
  sequence,
  snapshot: { messages: [{ id: "a", text }], providerSessionId: "one" },
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("live snapshots do not poll and ignore duplicate/out-of-order sequences", () => {
  const f = fixture();
  f.send(snapshot(1));
  f.send(snapshot(2, "Updated"));
  f.send(snapshot(1, "Stale"));
  assert.equal(f.snapshots.length, 2);
  assert.equal(f.snapshots.at(-1).messages[0].text, "Updated");
  assert.equal(f.reads, 0);
  assert.equal(f.timers.size, 0);
  f.dispose();
});

test("socket failures back off with at most three HTTP reads and dispose cleans up", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) {
    f.sockets.at(-1).onerror();
    await settle();
    assert.equal(f.timers.size, 1);
    f.tick();
  }
  assert.equal(f.reads, 3);
  f.dispose();
  assert.equal(f.timers.size, 0);
  assert.equal(f.sockets.at(-1).closed, true);
});

test("late fallback cannot overwrite a reconnect snapshot or disposed session", async () => {
  let release;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  f.sockets[0].onerror();
  f.tick();
  f.send(snapshot(1, "New session state"));
  release({ messages: [{ id: "old" }] });
  await settle();
  assert.equal(f.snapshots.length, 1);
  f.sockets.at(-1).onerror();
  f.dispose();
  release({ messages: [{ id: "disposed" }] });
  await settle();
  assert.equal(f.snapshots.length, 1);
});

test("visibility closes background socket and reconnects with fresh sequence", () => {
  const f = fixture();
  f.send(snapshot(100));
  f.visible(true);
  assert.equal(f.sockets[0].closed, true);
  assert.equal(f.timers.size, 0);
  f.visible(false);
  f.send(snapshot(1, "Resumed"));
  assert.equal(f.snapshots.at(-1).messages[0].text, "Resumed");
  f.dispose();
});

test("sync frames apply deltas and clear replaces the whole transcript", () => {
  const f = fixture();
  f.send({
    type: "sync",
    sequence: 1,
    data: {
      messages: [{ id: "a", text: "Old" }],
      providerSessionId: "one",
      sync: { mode: "full", cursor: "first" },
    },
  });
  f.send({
    type: "sync",
    sequence: 2,
    data: {
      sync: { mode: "delta", base: "first", cursor: "second" },
      metadata: { providerSessionId: "one" },
      upserts: [{ id: "a", text: "Edited" }],
      removed: [],
    },
  });
  assert.equal(f.snapshots.at(-1).messages[0].text, "Edited");
  f.send({
    type: "sync",
    sequence: 3,
    data: {
      providerSessionId: "two",
      messages: [],
      sync: { mode: "full", cursor: "clear" },
    },
  });
  assert.deepEqual(f.snapshots.at(-1).messages, []);
  f.dispose();
});

test("an invalid delta recovers through HTTP without publishing a partial update", async () => {
  const f = fixture(async () => ({
    providerSessionId: "one",
    messages: [{ id: "r", text: "Recovered" }],
  }));
  f.send(snapshot(1));
  f.send({
    type: "sync",
    sequence: 2,
    data: {
      sync: { mode: "delta", base: "missing", cursor: "new" },
      metadata: {},
      upserts: [],
      removed: [],
    },
  });
  await settle();
  assert.equal(f.reads, 1);
  assert.equal(f.snapshots.length, 2);
  assert.equal(f.snapshots.at(-1).messages[0].text, "Recovered");
  assert.equal(f.sockets[0].closed, true);
  f.dispose();
});

test("a socket that never supplies a snapshot times out and ended streams stop retrying", async () => {
  const f = fixture();
  f.sockets[0].onopen();
  f.tick();
  await settle();
  assert.equal(f.reads, 1);
  f.tick();
  f.send({ type: "ended" });
  assert.equal(f.connections.at(-1), "ended");
  assert.equal(f.timers.size, 0);
  f.visible(true);
  f.visible(false);
  assert.equal(f.sockets.length, 2);
  f.dispose();
});

test("a sequence gap recovers without applying the incomplete stream", async () => {
  const f = fixture();
  f.send(snapshot(1));
  f.send(snapshot(3, "Missed frame"));
  await settle();
  assert.equal(f.reads, 1);
  assert.equal(
    f.snapshots.some((value) => value.messages[0]?.text === "Missed frame"),
    false,
  );
  f.dispose();
});

test("hiding or disposing aborts an outstanding fallback request", async () => {
  const signals = [];
  const f = fixture((signal) => {
    signals.push(signal);
    return new Promise(() => {});
  });
  f.sockets[0].onerror();
  f.visible(true);
  assert.equal(signals[0].aborted, true);
  f.visible(false);
  f.sockets.at(-1).onerror();
  f.dispose();
  assert.equal(signals[1].aborted, true);
});

test("rolling windows retain only an evicted prefix and do not undo deletions", () => {
  const row = (id) => ({ id });
  const previous = { messages: [row("a"), row("b"), row("c")] };
  const next = { messages: [row("b"), row("c"), row("d")], history: { cursor: "older" } };
  assert.deepEqual(chatWindowPrefix(previous, next), [row("a")]);
  assert.deepEqual(
    chatWindowPrefix(previous, { ...next, messages: [row("b"), row("c")] }),
    [],
  );
  assert.deepEqual(
    chatWindowPrefix(previous, { ...next, messages: [row("a"), row("c"), row("d")] }),
    [],
  );
});
