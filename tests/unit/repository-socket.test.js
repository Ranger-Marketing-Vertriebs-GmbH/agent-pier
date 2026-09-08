import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { observeSocketClose } from "../helpers/repositories.js";

test("a cancelled Git socket is observed until close even when reset arrives first", async () => {
  const socket = new EventEmitter();
  const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
  let closed = false;
  const completion = observeSocketClose(socket).then((errors) => {
    closed = true;
    return errors;
  });
  socket.emit("error", reset);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false, "an error is not proof that the socket closed");
  socket.emit("close", true);
  assert.deepEqual(await completion, [reset]);
  assert.equal(socket.listenerCount("error"), 0);
  assert.equal(socket.listenerCount("close"), 0);
});

test("socket observation preserves unexpected errors for the cancellation assertion", async () => {
  const socket = new EventEmitter();
  const unexpected = Object.assign(new Error("fixture transport failed"), {
    code: "EIO",
  });
  const completion = observeSocketClose(socket);
  socket.emit("error", unexpected);
  socket.emit("close", true);
  const errors = await completion;
  assert.deepEqual(errors, [unexpected]);
  assert.throws(
    () => {
      for (const error of errors) assert.equal(error.code, "ECONNRESET", error.message);
    },
    { code: "ERR_ASSERTION" },
  );
});
