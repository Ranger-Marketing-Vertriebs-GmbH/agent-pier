import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { EventEmitter, getEventListeners } from "node:events";
import { nudge } from "../../vendor/agentbus/core/nudge.js";

function pendingSocket(t) {
  const socket = new EventEmitter();
  socket.destroyed = false;
  socket.writes = 0;
  socket.write = () => socket.writes++;
  socket.end = () => {};
  socket.destroy = () => {
    socket.destroyed = true;
    queueMicrotask(() => socket.emit("close"));
  };
  t.mock.method(net, "createConnection", () => socket);
  return socket;
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve("still pending"), 100);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
for (const kind of ["cc-socks", "oc-sock"]) {
  for (const connected of [false, true]) {
    test(`${kind} abort destroys ${connected ? "connected" : "pending"} socket and prevents late writes`, async (t) => {
      const socket = pendingSocket(t);
      const controller = new AbortController();
      const promise = nudge(
        {
          nudge: {
            kind,
            socketPath: "/fixture.sock",
            keyPath: "/fixture.key",
            sessionId: "native",
          },
        },
        "hint",
        "sender",
        {
          readKey: () => "private-fixture-token",
          signal: controller.signal,
        },
      );
      if (connected) socket.emit("connect");
      const before = socket.writes;
      controller.abort();
      assert.equal(await bounded(promise), false);
      assert.equal(socket.destroyed, true);
      socket.emit("connect");
      assert.equal(socket.writes, before);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    });
  }
  test(`${kind} deadline includes pending connect`, async (t) => {
    const socket = pendingSocket(t);
    const result = await bounded(
      nudge(
        {
          nudge: {
            kind,
            socketPath: "/fixture.sock",
            keyPath: "/fixture.key",
            sessionId: "native",
          },
        },
        "hint",
        "sender",
        {
          readKey: () => "private-fixture-token",
          timeoutMs: 5,
        },
      ),
    );
    assert.equal(result, false);
    assert.equal(socket.destroyed, true);
    socket.emit("connect");
    assert.equal(socket.writes, 0);
  });
}
