import test from "node:test";
import assert from "node:assert/strict";
import {
  CLOSE_BYTES,
  FLUSH_MS,
  LiveConnection,
  PRESENCE_PER_MINUTE,
  QUEUE_BYTES,
  SUBS_PER_MINUTE,
  parseClientFrame,
} from "../../server/features/live/live-connection.js";
import { LiveHub, unknownTopic } from "../../server/features/live/live-hub.js";

/** A socket whose buffered amount the test sets. */
function fakeSocket() {
  return {
    readyState: 1,
    bufferedAmount: 0,
    sent: [],
    closedWith: undefined,
    send(text) {
      this.sent.push(JSON.parse(text));
    },
    close(code) {
      this.closedWith = code;
      this.readyState = 3;
    },
  };
}

function fakeIntervals() {
  const running = new Set();
  return {
    timers: {
      setInterval: (fn) => {
        const handle = { fn };
        running.add(handle);
        return handle;
      },
      clearInterval: (handle) => running.delete(handle),
    },
    tick: () => [...running].forEach((handle) => handle.fn()),
    get running() {
      return running.size;
    },
  };
}

/** A hub stand-in that hands each subscription's `send` to the test. */
function fakeHub() {
  const subscriptions = [];
  return {
    subscriptions,
    subscribe(principal, topic, have, send, { discard } = {}) {
      const entry = { topic, have, send, discard, active: true };
      subscriptions.push(entry);
      return () => (entry.active = false);
    },
  };
}

function setup({
  hub = fakeHub(),
  maxTopics,
  presence,
  principal = { role: "owner" },
  now,
} = {}) {
  const ws = fakeSocket();
  const clock = fakeIntervals();
  const connection = new LiveConnection({
    ws,
    hub,
    principal,
    timers: clock.timers,
    ...(maxTopics ? { maxTopics } : {}),
    ...(presence ? { presence } : {}),
    ...(now ? { now } : {}),
  });
  return { ws, clock, connection, hub };
}

test("parseClientFrame accepts only the three ops with typed fields", () => {
  assert.deepEqual(parseClientFrame('{"op":"ping","x":1}'), { op: "ping" });
  assert.deepEqual(parseClientFrame('{"op":"unsub","topic":"a"}'), {
    op: "unsub",
    topic: "a",
  });
  assert.deepEqual(parseClientFrame('{"op":"sub","topic":"a","have":{"revision":1}}'), {
    op: "sub",
    topic: "a",
    have: { revision: 1 },
  });
  for (const text of [
    "nope",
    "null",
    "[]",
    '"sub"',
    '{"op":"other"}',
    '{"op":"sub"}',
    '{"op":"sub","topic":["a"]}',
    '{"op":"sub","topic":"a","have":[1]}',
    '{"op":"sub","topic":"a","have":null}',
    '{"op":"unsub","topic":1}',
  ])
    assert.equal(parseClientFrame(text), null, text);
});

test("a malformed frame asks to close and reaches no hub", () => {
  const { connection, hub } = setup();
  assert.equal(connection.receive('{"op":"drop","topic":"a"}'), false);
  assert.equal(hub.subscriptions.length, 0);
});

test("the limit counts held topics, resubscribing one takes no slot", () => {
  const { connection, hub, ws } = setup({ maxTopics: 2 });
  connection.receive('{"op":"sub","topic":"a"}');
  connection.receive('{"op":"sub","topic":"b"}');
  connection.receive('{"op":"sub","topic":"a"}');
  assert.equal(hub.subscriptions[0].active, false);
  connection.receive(JSON.stringify({ op: "sub", topic: "c".repeat(300) }));
  assert.deepEqual(ws.sent, [{ type: "error", topic: "c".repeat(200), code: "limit" }]);
  connection.receive('{"op":"unsub","topic":"b"}');
  connection.receive('{"op":"sub","topic":"c"}');
  assert.equal(hub.subscriptions.at(-1).topic, "c");
});

test("unknown and forbidden topics take one path and occupy a slot alike", () => {
  const hub = new LiveHub({ gate: (principal) => principal.role === "owner" });
  hub.define({
    name: "state",
    mode: "state",
    authorize: () => true,
    scopeKey: () => "owner",
    read: () => 1,
  });
  const ws = fakeSocket();
  const connection = new LiveConnection({
    ws,
    hub,
    principal: { role: "user", userId: "u" },
    maxTopics: 2,
  });
  connection.receive('{"op":"sub","topic":"state"}');
  connection.receive('{"op":"sub","topic":"nope"}');
  connection.receive('{"op":"sub","topic":"third"}');
  assert.deepEqual(ws.sent, [
    unknownTopic("state"),
    unknownTopic("nope"),
    { type: "error", topic: "third", code: "limit" },
  ]);
  connection.close();
  hub.close();
});

test("a frame from a replaced subscription is dropped", () => {
  const { connection, hub, ws } = setup();
  connection.receive('{"op":"sub","topic":"a"}');
  connection.receive('{"op":"sub","topic":"a"}');
  hub.subscriptions[0].send({ type: "state", topic: "a", data: "old" });
  hub.subscriptions[1].send({ type: "state", topic: "a", data: "new" });
  assert.deepEqual(
    ws.sent.map((frame) => frame.data),
    ["new"],
  );
});

test("a slow reader keeps the newest frame per topic and gets them in order", () => {
  const { connection, hub, ws, clock } = setup();
  connection.receive('{"op":"sub","topic":"a"}');
  connection.receive('{"op":"sub","topic":"b"}');
  const [a, b] = hub.subscriptions;
  ws.bufferedAmount = QUEUE_BYTES + 1;
  a.send({ type: "state", topic: "a", data: 1 });
  b.send({ type: "state", topic: "b", data: 1 });
  a.send({ type: "state", topic: "a", data: 2 });
  assert.equal(ws.sent.length, 0);
  clock.tick();
  assert.equal(ws.sent.length, 0);
  ws.bufferedAmount = 0;
  clock.tick();
  assert.deepEqual(
    ws.sent.map(({ topic, data }) => `${topic}${data}`),
    ["b1", "a2"],
  );
  assert.equal(clock.running, 0);
});

test("a delta whose predecessor waits resubscribes the topic without have", async () => {
  const { connection, hub, ws } = setup();
  connection.receive('{"op":"sub","topic":"rows","have":{"cursor":"c0"}}');
  ws.bufferedAmount = QUEUE_BYTES + 1;
  hub.subscriptions[0].send({ type: "delta", topic: "rows", data: 1 });
  hub.subscriptions[0].send({ type: "delta", topic: "rows", data: 2 });
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(hub.subscriptions.length, 2);
  assert.equal(hub.subscriptions[0].active, false);
  assert.equal(hub.subscriptions[1].have, undefined);
  // Both deltas are gone; the new subscription's snapshot replaces them.
  assert.equal(connection.pending.has("rows"), false);
  hub.subscriptions[0].send({ type: "delta", topic: "rows", data: 9 });
  hub.subscriptions[1].send({ type: "snapshot", topic: "rows", data: 3 });
  ws.bufferedAmount = 0;
  connection.flush();
  assert.deepEqual(
    ws.sent.map(({ type, data }) => `${type}${data}`),
    ["snapshot3"],
  );
});

test("above 2 MiB buffered the socket closes with 1013", () => {
  const { connection, hub, ws, clock } = setup();
  connection.receive('{"op":"sub","topic":"a"}');
  ws.bufferedAmount = QUEUE_BYTES + 1;
  hub.subscriptions[0].send({ type: "state", topic: "a", data: 1 });
  ws.bufferedAmount = CLOSE_BYTES + 1;
  clock.tick();
  assert.equal(ws.closedWith, 1013);
  assert.equal(hub.subscriptions[0].active, false);
  assert.equal(clock.running, 0);
  assert.ok(FLUSH_MS > 0);
});

test("a write that leaves more than 2 MiB buffered closes on the next tick", () => {
  const { connection, hub, ws, clock } = setup();
  connection.receive('{"op":"sub","topic":"a"}');
  ws.send = function (text) {
    this.sent.push(JSON.parse(text));
    this.bufferedAmount = CLOSE_BYTES + 1;
  };
  hub.subscriptions[0].send({ type: "state", topic: "a", data: 1 });
  assert.equal(ws.sent.length, 1);
  clock.tick();
  assert.equal(ws.closedWith, 1013);
});

test("revoked removes the topic, so it frees its slot", () => {
  const { connection, hub, ws } = setup({ maxTopics: 1 });
  connection.receive('{"op":"sub","topic":"a"}');
  hub.subscriptions[0].send({ type: "revoked", topic: "a" });
  assert.deepEqual(ws.sent, [{ type: "revoked", topic: "a" }]);
  connection.receive('{"op":"sub","topic":"b"}');
  assert.equal(hub.subscriptions.at(-1).topic, "b");
});

test("ping answers pong and close drops every subscription", () => {
  const { connection, hub, ws } = setup();
  connection.receive('{"op":"sub","topic":"a"}');
  connection.receive('{"op":"ping"}');
  assert.deepEqual(ws.sent, [{ type: "pong" }]);
  connection.close(1008);
  assert.equal(ws.closedWith, 1008);
  assert.equal(hub.subscriptions[0].active, false);
  assert.equal(connection.receive("garbage"), true);
});

test("a closing hub closes the connection with 1012 and stops its timer", () => {
  const hub = new LiveHub();
  const ws = fakeSocket();
  const clock = fakeIntervals();
  const connection = new LiveConnection({
    ws,
    hub,
    principal: { role: "owner" },
    timers: clock.timers,
  });
  ws.bufferedAmount = QUEUE_BYTES + 1;
  connection.reply({ type: "pong" });
  connection.schedule();
  assert.equal(clock.running, 1);
  hub.close();
  assert.equal(ws.closedWith, 1012);
  assert.equal(connection.closed, true);
  assert.equal(clock.running, 0);
  assert.equal(hub.closeListeners.size, 0);
});

test("a resync after the hub closed subscribes nothing", async () => {
  const hub = fakeHub();
  const { connection, ws } = setup({ hub });
  connection.receive('{"op":"sub","topic":"rows"}');
  ws.bufferedAmount = QUEUE_BYTES + 1;
  hub.subscriptions[0].send({ type: "delta", topic: "rows", data: 1 });
  hub.subscriptions[0].send({ type: "delta", topic: "rows", data: 2 });
  hub.closed = true;
  await new Promise((resolve) => queueMicrotask(resolve));
  assert.equal(hub.subscriptions.length, 1);
});

test("discard drops the frame a slow reader still waits for, of its topic only", () => {
  const { connection, hub, ws, clock } = setup();
  connection.receive('{"op":"sub","topic":"a"}');
  connection.receive('{"op":"sub","topic":"b"}');
  const [a, b] = hub.subscriptions;
  ws.bufferedAmount = QUEUE_BYTES + 1;
  a.send({ type: "state", topic: "a", data: "hers" });
  b.send({ type: "state", topic: "b", data: 1 });
  a.discard();
  ws.bufferedAmount = 0;
  clock.tick();
  assert.deepEqual(
    ws.sent.map(({ topic, data }) => `${topic}${data}`),
    ["b1"],
  );
  // A replaced subscription's discard leaves the new one's frame alone.
  connection.receive('{"op":"sub","topic":"a"}');
  ws.bufferedAmount = QUEUE_BYTES + 1;
  hub.subscriptions[2].send({ type: "state", topic: "a", data: "new" });
  a.discard();
  ws.bufferedAmount = 0;
  clock.tick();
  assert.equal(ws.sent.at(-1).data, "new");
});

test("a presence op reports the route in the owner's scope, a user's in her own", () => {
  const calls = [];
  const presence = (...args) => calls.push(args);
  const owner = setup({ presence });
  assert.equal(owner.connection.receive('{"op":"presence","route":"/inbox"}'), true);
  const user = setup({ presence, principal: { role: "user", userId: "u1" } });
  user.connection.receive('{"op":"presence","route":"/sessions/s1"}');
  assert.deepEqual(calls, [["/inbox"], ["/sessions/s1", { userId: "u1" }]]);
});

test("a presence op ignores an over-long route, throttles per socket, and needs a string", () => {
  const calls = [];
  let at = 0;
  const { connection } = setup({ presence: (route) => calls.push(route), now: () => at });
  connection.receive(
    JSON.stringify({ op: "presence", route: `/inbox${"x".repeat(600)}` }),
  );
  assert.deepEqual(calls, []);
  for (let i = 0; i < PRESENCE_PER_MINUTE + 10; i += 1)
    connection.receive('{"op":"presence","route":"/inbox"}');
  assert.equal(calls.length, PRESENCE_PER_MINUTE);
  at = 60000;
  connection.receive('{"op":"presence","route":"/inbox"}');
  assert.equal(calls.length, PRESENCE_PER_MINUTE + 1);
  assert.equal(connection.receive('{"op":"presence","route":5}'), false);
  assert.equal(connection.receive('{"op":"presence"}'), false);
});

test("a principal that is neither owner nor user never reports presence", () => {
  const calls = [];
  const { connection } = setup({
    presence: (...args) => calls.push(args),
    principal: { role: "user" },
  });
  connection.receive('{"op":"presence","route":"/inbox"}');
  assert.deepEqual(calls, []);
});

test("sub and unsub frames share a per-socket token bucket that refills over time", () => {
  let at = 1000;
  const { ws, connection, hub } = setup({ now: () => at });
  const sub = (topic) => connection.receive(JSON.stringify({ op: "sub", topic }));
  const unsub = (topic) => connection.receive(JSON.stringify({ op: "unsub", topic }));
  // A sub/unsub loop on one topic: every frame below the limit reaches the hub.
  for (let i = 0; i < SUBS_PER_MINUTE / 2; i += 1) {
    assert.equal(sub("state"), true);
    assert.equal(unsub("state"), true);
  }
  assert.equal(hub.subscriptions.length, SUBS_PER_MINUTE / 2);
  assert.deepEqual(ws.sent, []);
  // Over the limit a sub is refused like a full socket and never reaches the hub.
  assert.equal(sub("state"), true);
  assert.equal(hub.subscriptions.length, SUBS_PER_MINUTE / 2);
  assert.deepEqual(ws.sent, [{ type: "error", topic: "state", code: "limit" }]);
  assert.equal(connection.subscriptions.size, 0);
  assert.equal(ws.closedWith, undefined);
  // The bucket refills evenly: a tenth of a minute buys a tenth of the limit.
  at += 6000;
  for (let i = 0; i < SUBS_PER_MINUTE / 10; i += 1) sub(`topic-${i % 8}`);
  assert.equal(hub.subscriptions.length, SUBS_PER_MINUTE / 2 + SUBS_PER_MINUTE / 10);
  sub("state");
  assert.equal(ws.sent.length, 2);
  // A full minute refills the bucket, but never above the limit.
  at += 10 * 60000;
  for (let i = 0; i < SUBS_PER_MINUTE; i += 1) sub("state");
  assert.equal(ws.sent.length, 2);
  sub("state");
  assert.equal(ws.sent.length, 3);
});

test("an unsub over the limit still frees, and a refused re-sub drops the held topic", () => {
  let at = 0;
  const { ws, connection, hub } = setup({ now: () => at });
  for (let i = 0; i < SUBS_PER_MINUTE - 2; i += 1)
    connection.receive(JSON.stringify({ op: "sub", topic: `t${i % 2}` }));
  connection.receive('{"op":"sub","topic":"kept"}');
  connection.receive('{"op":"sub","topic":"state"}');
  assert.deepEqual([...connection.subscriptions.keys()], ["t0", "t1", "kept", "state"]);
  // The bucket is empty: the unsub is honoured all the same.
  connection.receive('{"op":"unsub","topic":"kept"}');
  assert.equal(connection.subscriptions.has("kept"), false);
  // The client takes a refused topic as gone, so the server lets go of it too.
  const held = hub.subscriptions.find((entry) => entry.topic === "state");
  connection.receive('{"op":"sub","topic":"state"}');
  assert.equal(held.active, false);
  assert.equal(connection.subscriptions.has("state"), false);
  assert.deepEqual(ws.sent, [{ type: "error", topic: "state", code: "limit" }]);
});
