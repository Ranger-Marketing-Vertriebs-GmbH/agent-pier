import test from "node:test";
import assert from "node:assert/strict";
import {
  LiveClient,
  failuresBeforeFallback,
  liveAuthCheckEvent,
  revokedRetryMs,
} from "../../web/lib/live/live-client.js";
import { fakeLive, rowsSnapshot } from "../helpers/fake-live.js";

function start(options) {
  const fake = fakeLive(options);
  const client = new LiveClient(fake.env);
  return { fake, client };
}
const recorder = () => {
  const events = [];
  const listener = (event) => events.push(event);
  listener.events = events;
  return listener;
};

test("subscribes after hello and resubscribes with have after a reconnect", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  const listener = recorder();
  client.subscribe("state", listener);
  assert.equal(fake.sockets.length, 1);
  assert.equal(fake.last().url, "ws://test/api/live");
  assert.deepEqual(fake.last().sent, []);
  fake.last().hello("i1");
  assert.deepEqual(fake.last().sent, [{ op: "sub", topic: "state" }]);
  fake.last().receive({
    type: "snapshot",
    topic: "state",
    revision: 4,
    data: rowsSnapshot([{ id: "a" }], "c1"),
  });
  const data = listener.events.filter((event) => event.type === "data");
  assert.deepEqual(data, [
    { type: "data", data: { sessions: [{ id: "a" }] }, revision: 4 },
  ]);
  fake.last().drop(1006);
  await fake.advance(500);
  assert.equal(fake.sockets.length, 2);
  fake.last().hello("i1");
  assert.deepEqual(fake.last().sent, [
    { op: "sub", topic: "state", have: { instance: "i1", cursor: "c1" } },
  ]);
});

test("a delta is applied onto the held rows; one that does not fit resubscribes", (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  const listener = recorder();
  client.subscribe("state", listener);
  fake.last().hello("i1");
  const socket = fake.last();
  socket.receive({
    type: "snapshot",
    topic: "state",
    revision: 1,
    data: rowsSnapshot([{ id: "a" }], "c1"),
  });
  socket.receive({
    type: "delta",
    topic: "state",
    revision: 2,
    data: {
      sync: { mode: "delta", base: "c1", cursor: "c2" },
      metadata: { shape: { sessions: "array" } },
      upserts: [{ id: "sessions/b", section: "sessions", value: { id: "b" } }],
      removed: ["sessions/a"],
      order: ["sessions/b"],
    },
  });
  assert.deepEqual(listener.events.at(-1), {
    type: "data",
    data: { sessions: [{ id: "b" }] },
    revision: 2,
  });
  socket.receive({
    type: "delta",
    topic: "state",
    revision: 3,
    data: {
      sync: { mode: "delta", base: "other", cursor: "c3" },
      metadata: { shape: { sessions: "array" } },
      upserts: [],
      removed: [],
    },
  });
  assert.deepEqual(socket.sent.at(-1), { op: "sub", topic: "state" });
  assert.equal(listener.events.at(-1).revision, 2);
});

test("state topics keep the revision as have and pass stale and changed on", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  const listener = recorder();
  client.subscribe("inbox", listener);
  fake.last().hello("i1");
  fake.last().receive({ type: "snapshot", topic: "inbox", revision: 7, data: { n: 1 } });
  fake.last().receive({ type: "state", topic: "inbox", revision: 8, data: { n: 2 } });
  fake.last().receive({ type: "stale", topic: "inbox", revision: 9 });
  fake.last().receive({ type: "changed", topic: "inbox", revision: 9 });
  assert.deepEqual(
    listener.events.filter((event) => event.type !== "status"),
    [
      { type: "data", data: { n: 1 }, revision: 7 },
      { type: "data", data: { n: 2 }, revision: 8 },
      { type: "stale" },
      { type: "changed" },
    ],
  );
  // A later listener is told the pushed value went stale, not shown the old one.
  const late = recorder();
  client.subscribe("inbox", late);
  assert.deepEqual(late.events, [{ type: "stale" }]);
  fake.last().drop(1012);
  await fake.advance(0);
  fake.last().hello("i1");
  assert.deepEqual(fake.last().sent, [
    { op: "sub", topic: "inbox", have: { instance: "i1", revision: 9 } },
  ]);
});

test("unknown topics are unsubscribed and reported once", (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  const listener = recorder();
  client.subscribe("nope", listener);
  fake.last().hello();
  fake.last().receive({ type: "error", topic: "nope", code: "unknown-topic" });
  assert.deepEqual(fake.last().sent.at(-1), { op: "unsub", topic: "nope" });
  assert.deepEqual(listener.events.at(-1), { type: "error", code: "unknown-topic" });
  fake.last().receive({ type: "error", topic: "state" });
  fake.last().receive({ type: "revoked", topic: "nope" });
  assert.equal(listener.events.filter((event) => event.type === "error").length, 1);
});

test("backs off from 500 ms to at most 30 s with jitter", async (t) => {
  const delays = async (random) => {
    const { fake, client } = start({ random });
    t.after(() => client.close());
    client.subscribe("state", () => {});
    const seen = [];
    for (let i = 0; i < 9; i++) {
      fake.last().drop(1006);
      seen.push(fake.nextDelay());
      await fake.advance(fake.nextDelay());
    }
    assert.equal(fake.sockets.length, 10);
    return seen;
  };
  assert.deepEqual(
    await delays(0),
    [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000],
  );
  const jittered = await delays(0.99);
  assert.ok(jittered[0] > 500 && jittered[0] <= 750, `first ${jittered[0]}`);
  assert.ok(jittered.every((delay) => delay <= 30000));
  assert.equal(jittered.at(-1), 30000);
});

test("three failed handshakes switch to fallback; hello ends it", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  const listener = recorder();
  client.subscribe("state", listener);
  assert.equal(failuresBeforeFallback, 3);
  for (let i = 1; i <= 3; i++) {
    assert.equal(client.status().fallback, false);
    fake.last().drop(1006);
    await fake.advance(fake.nextDelay());
  }
  assert.deepEqual(client.status(), { connected: false, fallback: true });
  assert.deepEqual(listener.events.at(-1), {
    type: "status",
    connected: false,
    fallback: true,
  });
  // The socket keeps being retried during the fallback.
  assert.equal(fake.sockets.length, 4);
  fake.last().hello();
  assert.deepEqual(client.status(), { connected: true, fallback: false });
  assert.deepEqual(listener.events.at(-1), {
    type: "status",
    connected: true,
    fallback: false,
  });
  // A connection that worked once counts its next failures from zero.
  fake.last().drop(1006);
  await fake.advance(fake.nextDelay());
  assert.equal(fake.nextDelay(), null);
  assert.deepEqual(client.status(), { connected: false, fallback: false });
});

test("1012 reconnects at once; 1008 dispatches the auth check event", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  let checks = 0;
  fake.env.window.addEventListener(liveAuthCheckEvent, () => (checks += 1));
  client.subscribe("state", () => {});
  fake.last().hello();
  fake.last().drop(1012);
  assert.equal(fake.nextDelay(), 0);
  await fake.advance(0);
  assert.equal(fake.sockets.length, 2);
  fake.last().hello("i2");
  fake.last().drop(1008);
  assert.equal(checks, 1);
  assert.ok(fake.nextDelay() >= 500);
});

test("pings every 25 s", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  client.subscribe("state", () => {});
  fake.last().hello();
  const socket = fake.last();
  socket.answersPings = false;
  const pings = () => socket.sent.filter((frame) => frame.op === "ping").length;
  await fake.advance(24999);
  assert.equal(pings(), 0);
  await fake.advance(1);
  assert.equal(pings(), 1);
  socket.receive({ type: "pong" });
  await fake.advance(25000);
  assert.equal(pings(), 2);
  socket.receive({ type: "pong" });
  await fake.advance(25000);
  assert.equal(pings(), 3);
  assert.equal(fake.sockets.length, 1);
});

test("a socket that stops answering is replaced", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  client.subscribe("state", () => {});
  fake.last().hello();
  const silent = fake.last();
  silent.answersPings = false;
  await fake.advance(50000);
  assert.notEqual(silent.closedWith, undefined);
  await fake.advance(500);
  assert.equal(fake.sockets.length, 2);
  // The late close of the replaced socket changes nothing.
  silent.drop(1006);
  await fake.advance(60000);
  assert.equal(fake.sockets.length, 2);
});

test("one socket however many topics", (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  const off = client.subscribe("state", () => {});
  client.subscribe("inbox", () => {});
  client.subscribe("session.models:a", () => {}, { sampled: true });
  client.subscribe("session.models:a", () => {}, { sampled: true });
  assert.equal(fake.sockets.length, 1);
  fake.last().hello();
  assert.deepEqual(
    fake.last().sent.map((frame) => frame.topic),
    ["state", "inbox", "session.models:a"],
  );
  client.subscribe("session.requests:a", () => {});
  off();
  assert.deepEqual(fake.last().sent.slice(3), [
    { op: "sub", topic: "session.requests:a" },
    { op: "unsub", topic: "state" },
  ]);
  assert.equal(fake.sockets.length, 1);
});

test("close ends the socket and all timers", (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  client.subscribe("state", () => {});
  fake.last().hello();
  client.close();
  assert.equal(fake.last().closedWith, 1000);
  assert.equal(fake.timers.size, 0);
  client.subscribe("inbox", () => {});
  assert.equal(fake.sockets.length, 1);
});

test("a later listener gets the held data, or the stale or refusal in its place", (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  for (const topic of ["inbox", "session.models:a", "session.requests:a", "nope"])
    client.subscribe(topic, () => {});
  fake.last().hello();
  const socket = fake.last();
  socket.receive({ type: "snapshot", topic: "inbox", revision: 1, data: { n: 1 } });
  socket.receive({ type: "error", topic: "session.models:a", code: "limit" });
  socket.receive({
    type: "snapshot",
    topic: "session.requests:a",
    revision: 1,
    data: [],
  });
  socket.receive({ type: "revoked", topic: "session.requests:a" });
  socket.receive({ type: "error", topic: "nope", code: "unknown-topic" });
  const late = (topic) => {
    const listener = recorder();
    client.subscribe(topic, listener);
    return listener.events;
  };
  assert.deepEqual(late("inbox"), [{ type: "data", data: { n: 1 }, revision: 1 }]);
  assert.deepEqual(late("session.models:a"), [{ type: "error", code: "limit" }]);
  assert.deepEqual(late("session.requests:a"), [{ type: "revoked" }]);
  assert.deepEqual(late("nope"), [{ type: "error", code: "unknown-topic" }]);
  socket.receive({ type: "stale", topic: "inbox", revision: 2 });
  assert.deepEqual(late("inbox"), [{ type: "stale" }]);
  socket.receive({ type: "state", topic: "inbox", revision: 3, data: { n: 3 } });
  assert.deepEqual(late("inbox"), [{ type: "data", data: { n: 3 }, revision: 3 }]);
});

test("a refusal is forgotten by the next connection, which subscribes again", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  client.subscribe("nope", () => {});
  fake.last().hello();
  fake.last().receive({ type: "error", topic: "nope", code: "unknown-topic" });
  fake.last().drop(1012);
  await fake.advance(0);
  fake.last().hello();
  assert.deepEqual(fake.last().sent, [{ op: "sub", topic: "nope" }]);
  const late = recorder();
  client.subscribe("nope", late);
  assert.deepEqual(late.events, []);
});

test("a server that closes right after hello is retried with growing delays", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  client.subscribe("state", () => {});
  const delays = [];
  for (let i = 0; i < 3; i++) {
    fake.last().hello();
    fake.last().drop(1013);
    delays.push(fake.nextDelay());
    await fake.advance(fake.nextDelay());
  }
  assert.deepEqual(delays, [500, 1000, 2000]);
  // Ten seconds open count as working: the backoff starts over.
  fake.last().hello();
  await fake.advance(10000);
  fake.last().drop(1013);
  assert.equal(fake.nextDelay(), 500);
});

test("subscribing during an outage keeps the pending retry", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  client.subscribe("state", () => {});
  fake.last().drop(1006);
  client.subscribe("inbox", () => {});
  assert.equal(fake.sockets.length, 1);
  await fake.advance(500);
  assert.equal(fake.sockets.length, 2);
});

test("sampled comes from the registry whatever the caller passes", (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  client.subscribe("session.models:a", () => {});
  fake.last().hello();
  fake.setHidden(true);
  assert.deepEqual(fake.last().sent.at(-1), { op: "unsub", topic: "session.models:a" });
});

test("waking after sleep with online at once ends with one socket that resubscribes with have", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  client.subscribe("inbox", () => {});
  fake.last().hello("i1");
  const asleep = fake.last();
  asleep.answersPings = false;
  asleep.receive({ type: "snapshot", topic: "inbox", revision: 4, data: { n: 4 } });
  await fake.advance(50000);
  assert.notEqual(asleep.closedWith, undefined);
  fake.fire("online");
  await fake.advance(60000);
  assert.equal(fake.sockets.length, 2);
  fake.last().hello("i1");
  assert.deepEqual(fake.last().sent, [
    { op: "sub", topic: "inbox", have: { instance: "i1", revision: 4 } },
  ]);
});

test("a signal topic keeps its first revision, so a missed change comes back", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  const listener = recorder();
  client.subscribe("pipeline.runs.changed:p1", listener);
  fake.last().hello("i1");
  fake.last().receive({ type: "same", topic: "pipeline.runs.changed:p1", revision: 3 });
  assert.deepEqual(
    listener.events.filter((event) => event.type !== "status"),
    [],
  );
  fake.last().drop(1006);
  await fake.advance(500);
  fake.last().hello("i1");
  assert.deepEqual(fake.last().sent, [
    {
      op: "sub",
      topic: "pipeline.runs.changed:p1",
      have: { instance: "i1", revision: 3 },
    },
  ]);
});

test("presence goes over the open socket and is declined while the channel is not", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  client.subscribe("state", recorder());
  assert.equal(client.sendPresence("/inbox"), false);
  fake.last().hello("i1");
  assert.equal(client.sendPresence("/inbox"), true);
  assert.deepEqual(fake.last().sent.at(-1), { op: "presence", route: "/inbox" });
  fake.last().drop(1006);
  assert.equal(client.sendPresence("/inbox"), false);
});

test("a revoked topic is subscribed again while visible and recovers when re-granted", async (t) => {
  const { fake, client } = start();
  t.after(() => client.close());
  const listener = recorder();
  const topic = "agent.actions:a";
  client.subscribe(topic, listener);
  fake.last().hello("i1");
  const socket = fake.last();
  const subs = () =>
    socket.sent.filter((f) => f.op === "sub" && f.topic === topic).length;
  socket.receive({ type: "state", topic, revision: 1, data: { actions: [1] } });
  socket.receive({ type: "revoked", topic });
  assert.equal(subs(), 1);
  await fake.advance(revokedRetryMs);
  assert.equal(subs(), 2);
  // Still refused: it stays revoked for its listeners, and nothing is read.
  socket.receive({ type: "error", topic, code: "unknown-topic" });
  assert.deepEqual(socket.sent.at(-1), { op: "unsub", topic });
  assert.deepEqual(
    listener.events.filter((e) => !["data", "status"].includes(e.type)),
    [{ type: "revoked" }],
  );
  // A hidden tab does not try.
  fake.setHidden(true);
  await fake.advance(revokedRetryMs * 2);
  assert.equal(subs(), 2);
  fake.setHidden(false);
  await fake.advance(revokedRetryMs);
  assert.equal(subs(), 3);
  // Access came back: the topic answers again in place.
  socket.receive({ type: "state", topic, revision: 2, data: { actions: [2] } });
  assert.deepEqual(listener.events.at(-1), {
    type: "data",
    data: { actions: [2] },
    revision: 2,
  });
});
