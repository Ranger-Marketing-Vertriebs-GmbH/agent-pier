import assert from "node:assert/strict";
import test from "node:test";
import { connectTerminal } from "../../web/features/terminal/terminal-connection.js";

function fixture() {
  const document = new EventTarget();
  document.visibilityState = "visible";
  const window = new EventTarget();
  const sockets = [],
    events = [],
    timers = new Map();
  let next = 0;
  const connection = connectTerminal({
    document,
    window,
    createSocket() {
      const socket = {
        readyState: 0,
        sent: [],
        close() {
          this.readyState = 3;
          this.onclose?.();
        },
        send(data) {
          this.sent.push(data);
        },
      };
      sockets.push(socket);
      return socket;
    },
    onOpen: () => events.push("open"),
    onMessage: (event) => events.push(event.data),
    onState: (state) => events.push(state),
    setTimer(fn, delay) {
      const id = ++next;
      timers.set(id, { fn, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
  });
  return {
    document,
    window,
    sockets,
    events,
    timers,
    connection,
    flush() {
      const pending = [...timers.values()];
      timers.clear();
      for (const { fn } of pending) fn();
    },
    open(socket = sockets.at(-1)) {
      socket.readyState = 1;
      socket.onopen();
    },
    hide() {
      document.visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    },
    show() {
      document.visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
    },
  };
}

test("wake events replace a stale socket once and ignore its callbacks", () => {
  const f = fixture();
  f.open();
  const old = f.sockets[0];
  f.hide();
  f.show();
  f.window.dispatchEvent(new Event("online"));
  const page = new Event("pageshow");
  page.persisted = true;
  f.window.dispatchEvent(page);
  assert.equal(f.timers.size, 1);
  f.flush();
  assert.equal(f.sockets.length, 2);
  f.open();
  const before = [...f.events];
  old.onmessage({ data: "stale" });
  old.onopen();
  old.onclose();
  old.onerror();
  assert.deepEqual(f.events, before);
  assert.equal(f.timers.size, 0);
  f.connection.dispose();
});

test("input is sent once and never replayed after reconnect", () => {
  const f = fixture();
  assert.equal(f.connection.send("before open"), false);
  f.open();
  assert.equal(f.connection.send("input"), true);
  f.hide();
  f.show();
  f.flush();
  f.open();
  assert.deepEqual(f.sockets[0].sent, ["input"]);
  assert.deepEqual(f.sockets[1].sent, []);
  f.connection.dispose();
});

test("backoff waits while hidden and cleanup cancels every listener and timer", () => {
  const f = fixture();
  f.sockets[0].onclose();
  assert.equal([...f.timers.values()][0].delay, 1000);
  f.flush();
  f.sockets[1].onclose();
  assert.equal([...f.timers.values()][0].delay, 2000);
  f.hide();
  f.flush();
  assert.equal(f.sockets.length, 2);
  f.show();
  f.flush();
  assert.equal(f.sockets.length, 3);
  f.connection.dispose();
  f.hide();
  f.show();
  f.window.dispatchEvent(new Event("online"));
  f.flush();
  assert.equal(f.sockets.length, 3);
  assert.equal(f.sockets[2].readyState, 3);
});

test("network recovery also replaces a potentially stalled connecting socket", () => {
  const f = fixture();
  f.window.dispatchEvent(new Event("online"));
  f.flush();
  assert.equal(f.sockets.length, 2);
  // A connection started before suspension is potentially stale, even if connecting.
  f.hide();
  f.show();
  f.flush();
  assert.equal(f.sockets.length, 3);
  f.connection.dispose();
});

test("a failed send recovers without replaying the rejected input", () => {
  const f = fixture();
  f.open();
  f.sockets[0].send = () => {
    throw new Error("transport unavailable");
  };
  assert.equal(f.connection.send("not replayed"), false);
  f.flush();
  f.open();
  assert.deepEqual(f.sockets[1].sent, []);
  f.connection.dispose();
});

test("callbacks queued before disposal cannot update terminal state", () => {
  const f = fixture();
  const socket = f.sockets[0];
  f.connection.dispose();
  const before = [...f.events];
  socket.onopen();
  socket.onmessage({ data: "late output" });
  socket.onerror();
  socket.onclose();
  assert.deepEqual(f.events, before);
  assert.equal(f.connection.send("late input"), false);
  assert.equal(f.timers.size, 0);
});
