import test from "node:test";
import assert from "node:assert/strict";
import { LiveClient, hiddenCloseMs } from "../../web/lib/live/live-client.js";
import { fakeLive, rowsSnapshot } from "../helpers/fake-live.js";

// A client holding `state` (event-driven) and `session.models:a` (sampled), both
// with data, so resubscribes carry `have`.
function started(options) {
  const fake = fakeLive(options);
  const client = new LiveClient(fake.env);
  client.subscribe("state", () => {});
  client.subscribe("session.models:a", () => {}, { sampled: true });
  return { fake, client };
}
const feed = (socket) => {
  socket.receive({
    type: "snapshot",
    topic: "state",
    revision: 1,
    data: rowsSnapshot([{ id: "a" }], "c1"),
  });
  socket.receive({ type: "snapshot", topic: "session.models:a", revision: 5, data: [] });
};
const withHave = [
  { op: "sub", topic: "state", have: { instance: "i1", cursor: "c1" } },
  { op: "sub", topic: "session.models:a", have: { instance: "i1", revision: 5 } },
];

test("hidden unsubscribes sampled topics at once and keeps event topics", (t) => {
  const { fake, client } = started();
  t.after(() => client.close());
  fake.last().hello("i1");
  feed(fake.last());
  fake.setHidden(true);
  assert.deepEqual(fake.last().sent.slice(2), [
    { op: "unsub", topic: "session.models:a" },
  ]);
  fake.setHidden(false);
  assert.deepEqual(fake.last().sent.slice(3), [withHave[1]]);
  assert.equal(fake.sockets.length, 1);
});

test("five minutes hidden closes the socket; visible reconnects and resubscribes", async (t) => {
  const { fake, client } = started();
  t.after(() => client.close());
  fake.last().hello("i1");
  feed(fake.last());
  fake.setHidden(true);
  assert.equal(hiddenCloseMs, 300000);
  await fake.advance(hiddenCloseMs - 1);
  assert.equal(fake.last().closedWith, undefined);
  await fake.advance(1);
  assert.equal(fake.last().closedWith, 1000);
  assert.equal(fake.timers.size, 0);
  assert.deepEqual(client.status(), { connected: false, fallback: false });
  fake.setHidden(false);
  assert.equal(fake.sockets.length, 2);
  fake.last().hello("i1");
  assert.deepEqual(fake.last().sent, withHave);
});

test("pagehide closes; pageshow with persisted reconnects once", async (t) => {
  const { fake, client } = started();
  t.after(() => client.close());
  fake.last().hello("i1");
  feed(fake.last());
  fake.env.document.hidden = true;
  fake.fire("pagehide", { persisted: true });
  fake.env.document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(fake.last().closedWith, 1000);
  assert.equal(fake.timers.size, 0);
  // Restored from the back/forward cache: visible again, pageshow, then online.
  fake.env.document.hidden = false;
  fake.fire("pageshow", { persisted: true });
  fake.env.document.dispatchEvent(new Event("visibilitychange"));
  fake.fire("online");
  await fake.advance(60000);
  assert.equal(fake.sockets.length, 2);
  fake.last().hello("i1");
  assert.deepEqual(fake.last().sent.slice(0, 2), withHave);
});

test("pagehide while visible reconnects on pageshow", async (t) => {
  const { fake, client } = started();
  t.after(() => client.close());
  fake.last().hello("i1");
  fake.fire("pagehide", { persisted: true });
  await fake.advance(60000);
  assert.equal(fake.sockets.length, 1);
  fake.fire("pageshow", { persisted: true });
  fake.fire("online");
  assert.equal(fake.sockets.length, 2);
});

test("hidden during the handshake ends with one socket and no sampled subscriptions", async (t) => {
  const { fake, client } = started();
  t.after(() => client.close());
  fake.setHidden(true);
  fake.last().hello("i1");
  assert.deepEqual(fake.last().sent, [{ op: "sub", topic: "state" }]);
  await fake.advance(60000);
  assert.equal(fake.sockets.length, 1);
  fake.setHidden(false);
  assert.deepEqual(
    fake.last().sent.filter((frame) => frame.op !== "ping"),
    [
      { op: "sub", topic: "state" },
      { op: "sub", topic: "session.models:a" },
    ],
  );
  assert.equal(fake.sockets.length, 1);
});

test("a handshake that fails while hidden waits for visible", async (t) => {
  const { fake, client } = started();
  t.after(() => client.close());
  fake.setHidden(true);
  fake.last().drop(1006);
  await fake.advance(hiddenCloseMs * 2);
  assert.equal(fake.sockets.length, 1);
  assert.equal(fake.timers.size, 0);
  fake.setHidden(false);
  assert.equal(fake.sockets.length, 2);
});

test("no reconnect attempts while hidden after the close", async (t) => {
  const { fake, client } = started();
  t.after(() => client.close());
  fake.last().hello("i1");
  feed(fake.last());
  fake.setHidden(true);
  await fake.advance(hiddenCloseMs);
  fake.fire("online");
  fake.fire("pageshow", { persisted: false });
  await fake.advance(hiddenCloseMs * 4);
  assert.equal(fake.sockets.length, 1);
  // A connection the server drops while hidden is not retried either.
  fake.setHidden(false);
  fake.last().hello("i1");
  fake.setHidden(true);
  fake.last().drop(1012);
  await fake.advance(hiddenCloseMs * 2);
  assert.equal(fake.sockets.length, 2);
  // Subscribing while hidden opens nothing.
  client.subscribe("inbox", () => {});
  assert.equal(fake.sockets.length, 2);
  fake.setHidden(false);
  assert.equal(fake.sockets.length, 3);
  fake.last().hello("i1");
  assert.deepEqual(
    fake.last().sent.map((frame) => frame.topic),
    ["state", "session.models:a", "inbox"],
  );
});

test("a subscription made while hidden opens the socket on visible", (t) => {
  const fake = fakeLive({ hidden: true });
  const client = new LiveClient(fake.env);
  t.after(() => client.close());
  client.subscribe("state", () => {});
  assert.equal(fake.sockets.length, 0);
  fake.setHidden(false);
  assert.equal(fake.sockets.length, 1);
});
