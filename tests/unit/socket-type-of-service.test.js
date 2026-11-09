import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import diagnostics from "node:diagnostics_channel";
import { guardTypeOfService } from "../../server/lib/socket-type-of-service.js";

const errno = (syscall) =>
  Object.assign(Error(`${syscall} EINVAL`), { code: "EINVAL", errno: -22, syscall });

test("a failing setTypeOfService is ignored, an invalid argument still throws", () => {
  const calls = [];
  class Socket {
    setTypeOfService(tos) {
      calls.push(tos);
      if (tos === 1) throw errno("setTypeOfService");
      if (tos === 2) throw Object.assign(RangeError("out of range"), { code: "ERR" });
      return this;
    }
  }
  guardTypeOfService(Socket);
  const guarded = Socket.prototype.setTypeOfService;
  guardTypeOfService(Socket);
  assert.equal(Socket.prototype.setTypeOfService, guarded, "installed once");
  const socket = new Socket();
  assert.equal(socket.setTypeOfService(0), socket);
  assert.equal(socket.setTypeOfService(1), socket);
  assert.throws(() => socket.setTypeOfService(2), RangeError);
  assert.deepEqual(calls, [0, 1, 2]);
});

// A peer that accepts and resets every connection at once, in a process of its own so
// that the reset arrives while this process's loop is blocked.
async function resettingPeer(t) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      `const net = require("node:net");
       const server = net.createServer((socket) => socket.resetAndDestroy());
       server.listen(0, "127.0.0.1", () => console.log(server.address().port));`,
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  t.after(() => child.kill());
  return Number(
    await new Promise((resolve, reject) => {
      child.stdout.once("data", (data) => resolve(String(data)));
      child.once("error", reject);
    }),
  );
}

test("a fetch whose connection is reset before its first write rejects", async (t) => {
  const port = await resettingPeer(t);
  // Block the loop after the socket starts connecting: by the time undici writes, the
  // peer has reset the connection (macOS then fails setsockopt with EINVAL).
  const block = () =>
    queueMicrotask(() => {
      const until = Date.now() + 100;
      while (Date.now() < until);
    });
  diagnostics.subscribe("net.client.socket", block);
  t.after(() => diagnostics.unsubscribe("net.client.socket", block));
  const uncaught = [];
  const record = (error) => uncaught.push(`${error.code} ${error.syscall}`);
  process.on("uncaughtException", record);
  t.after(() => process.off("uncaughtException", record));
  for (let n = 0; n < 5; n++)
    await assert.rejects(fetch(`http://127.0.0.1:${port}/json/version`), TypeError);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(uncaught, []);
});
