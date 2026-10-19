import test from "node:test";
import assert from "node:assert/strict";
import { createChatStream } from "../../web/features/chat/chat-stream-transport.js";
import { nextStream } from "../../web/features/assistants/stream-reply.js";

// The agent chat feed on the shared transport, as useAgentConversationStream uses it.
function feed({ initial, read = async () => full("http", ["a"]) } = {}) {
  const timers = new Map();
  const sockets = [];
  const lives = [];
  const reads = [];
  const listeners = {};
  let stream = null;
  const runs = new Map();
  const visibility = {
    hidden: false,
    addEventListener: (_, fn) => (listeners.visible = fn),
    removeEventListener: () => {},
  };
  const network = {
    addEventListener: (_, fn) => (listeners.online = fn),
    removeEventListener: () => {},
  };
  const dispose = createChatStream({
    initial,
    address: (cursor) => `ws://feed/stream${cursor ? `?cursor=${cursor}` : ""}`,
    read: (signal, cursor) => {
      reads.push(cursor);
      return read(signal, cursor);
    },
    onSnapshot: (value) => lives.push(value),
    onFrame: (frame) => {
      if (frame.type !== "stream") return;
      const next = nextStream(runs.get(frame.runId), frame);
      if (!next) return false;
      runs.set(frame.runId, next);
      stream = next;
    },
    onConnection: () => {},
    onError: () => {},
    retryNow: (code) => code === 1013,
    network,
    visibility,
    schedule: (fn, delay) => {
      const id = Symbol();
      timers.set(id, { fn, delay });
      return id;
    },
    cancel: (id) => timers.delete(id),
    createSocket: (url) => {
      const socket = { url, close() {} };
      sockets.push(socket);
      return socket;
    },
  });
  return {
    dispose,
    sockets,
    lives,
    reads,
    timers,
    get stream() {
      return stream;
    },
    send(frame) {
      sockets.at(-1).onmessage({ data: JSON.stringify(frame) });
    },
    retry() {
      const [id, timer] = [...timers].sort((a, b) => a[1].delay - b[1].delay)[0];
      timers.delete(id);
      timer.fn();
    },
    delays: () => [...timers.values()].map((t) => t.delay),
    visible(hidden) {
      visibility.hidden = hidden;
      listeners.visible();
    },
    online: () => listeners.online(),
  };
}
const rows = (ids) => ids.map((id) => ({ id, role: "assistant", text: id }));
const full = (cursor, ids) => ({
  messages: rows(ids),
  requests: [],
  stale: false,
  nextBefore: null,
  sync: { mode: "full", cursor },
});
const delta = (base, cursor, upserts, order) => ({
  sync: { mode: "delta", base, cursor },
  metadata: { requests: [], stale: false, nextBefore: null, queued: null },
  upserts: rows(upserts),
  removed: [],
  ...(order ? { order } : {}),
});
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("a cached window resumes the feed from its cursor and applies the delta", () => {
  const f = feed({ initial: full("c1", ["a"]) });
  assert.equal(f.sockets[0].url, "ws://feed/stream?cursor=c1");
  f.send({ type: "sync", sequence: 1, data: delta("c1", "c2", ["b"], ["a", "b"]) });
  assert.deepEqual(
    f.lives.at(-1).messages.map((m) => m.id),
    ["a", "b"],
  );
  assert.equal(f.lives.at(-1).sync.cursor, "c2");
});

test("a sequence gap reconnects with the held cursor", () => {
  const f = feed();
  f.send({ type: "sync", sequence: 1, data: full("c1", ["a"]) });
  f.send({ type: "sync", sequence: 3, data: delta("c1", "c3", ["b"], ["a", "b"]) });
  assert.equal(f.lives.length, 1);
  f.retry();
  assert.equal(f.sockets.at(-1).url, "ws://feed/stream?cursor=c1");
});

test("a delta on another base drops the baseline and reconnects for a full window", () => {
  const f = feed();
  f.send({ type: "sync", sequence: 1, data: full("c1", ["a"]) });
  f.send({ type: "sync", sequence: 2, data: delta("other", "c3", ["b"], ["a", "b"]) });
  assert.equal(f.lives.length, 1);
  // A pending fallback timer comes first; the reconnect follows the backoff.
  while (f.sockets.length === 1) f.retry();
  assert.equal(f.sockets.at(-1).url, "ws://feed/stream");
});

test("hiding closes the feed and showing resumes it with the cursor", () => {
  const f = feed();
  f.send({ type: "sync", sequence: 1, data: full("c1", ["a"]) });
  f.visible(true);
  assert.equal(f.sockets.length, 1);
  f.visible(false);
  assert.equal(f.sockets.length, 2);
  assert.equal(f.sockets[1].url, "ws://feed/stream?cursor=c1");
});

test("stream frames append; a frame that does not fit reconnects", () => {
  const f = feed();
  f.send({ type: "sync", sequence: 1, data: full("c1", ["a"]) });
  f.send({ type: "stream", runId: "r", from: 0, text: "Hel" });
  f.send({ type: "stream", runId: "r", from: 3, text: "lo" });
  assert.deepEqual(f.stream, { runId: "r", text: "Hello" });
  // A frame for text the client never got does not fit.
  f.send({ type: "stream", runId: "r", from: 9, text: "!" });
  assert.deepEqual(f.stream, { runId: "r", text: "Hello" });
  assert.equal(f.timers.size > 0, true, "a reconnect is scheduled");
  while (f.sockets.length === 1) f.retry();
  assert.equal(f.sockets.at(-1).url, "ws://feed/stream?cursor=c1");
  // The new socket sends the whole text again.
  f.send({ type: "stream", runId: "r", from: 0, text: "Hello!" });
  assert.deepEqual(f.stream, { runId: "r", text: "Hello!" });
});

test("a socket closed for falling behind retries without backoff", () => {
  const f = feed();
  f.send({ type: "sync", sequence: 1, data: full("c1", ["a"]) });
  f.sockets[0].onclose({ code: 1006 });
  f.retry();
  f.sockets[1].onclose({ code: 1006 });
  assert.ok(f.delays().includes(2000), `backoff grows: ${f.delays()}`);
  f.retry();
  f.sockets[2].onclose({ code: 1013 });
  assert.ok(f.delays().includes(1000), `1013 retries at once: ${f.delays()}`);
  assert.ok(!f.delays().includes(4000));
});

test("coming back online reconnects a dead feed at once", () => {
  const f = feed();
  f.send({ type: "sync", sequence: 1, data: full("c1", ["a"]) });
  f.online();
  assert.equal(f.sockets.length, 1, "a live feed stays");
  f.sockets[0].onclose({ code: 1006 });
  f.online();
  assert.equal(f.sockets.at(-1).url, "ws://feed/stream?cursor=c1");
  assert.equal(f.sockets.length, 2);
});

test("refresh reads over HTTP with the cursor only while no socket delivers", async () => {
  const f = feed({
    read: async (_signal, cursor) => delta(cursor, "h2", ["b"], ["a", "b"]),
  });
  f.send({ type: "sync", sequence: 1, data: full("c1", ["a"]) });
  await f.dispose.refresh();
  assert.deepEqual(f.reads, []);
  f.sockets[0].onclose({ code: 1006 });
  await settle();
  // The close itself reads once with the held cursor; refresh reads again.
  assert.deepEqual(f.reads, ["c1"]);
  await f.dispose.refresh();
  await settle();
  assert.deepEqual(f.reads, ["c1", "h2"]);
  assert.deepEqual(
    f.lives.at(-1).messages.map((m) => m.id),
    ["a", "b"],
  );
});

test("nextStream replaces at 0, appends at its end and refuses anything else", () => {
  assert.deepEqual(nextStream(null, { runId: "r", from: 0, text: "A" }), {
    runId: "r",
    text: "A",
  });
  assert.deepEqual(
    nextStream({ runId: "r", text: "A" }, { runId: "r", from: 1, text: "B" }),
    {
      runId: "r",
      text: "AB",
    },
  );
  assert.equal(
    nextStream({ runId: "r", text: "A" }, { runId: "r", from: 2, text: "B" }),
    null,
  );
  assert.equal(
    nextStream({ runId: "x", text: "A" }, { runId: "r", from: 1, text: "B" }),
    null,
  );
  assert.equal(nextStream(null, { runId: "r", from: -1, text: "B" }), null);
});
