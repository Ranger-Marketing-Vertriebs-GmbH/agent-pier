import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { fakeBotApi, fakeDeepgram } from "../helpers/assistant-telegram-fakes.js";

const token = "888:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

// A client that sends a request's headers and part of its body, then goes away: a
// Hermes gateway that AgentPier stops or restarts while it polls or uploads. Node
// rejects the fake's body read with ECONNRESET "aborted"; unhandled, that rejection
// failed whichever contract was running (hermes-telegram-bots-contract.test.js).
async function dropMidBody(base, pathname) {
  const { hostname, port } = new URL(base);
  const socket = net.connect(Number(port), hostname);
  await new Promise((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(
    `POST ${pathname} HTTP/1.1\r\nHost: ${hostname}\r\n` +
      'Content-Type: application/json\r\nContent-Length: 64\r\n\r\n{"timeout":',
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.destroy();
  // Long enough for the server to see the close and settle the read.
  await new Promise((resolve) => setTimeout(resolve, 100));
}

test("the fake Bot API outlives a client that drops in the middle of a request", async (t) => {
  const api = await fakeBotApi({ [token]: { id: 888, username: "pier_bot" } });
  t.after(() => api.close());
  await dropMidBody(api.url, `/bot${token}/getUpdates`);
  const response = await fetch(`${api.url}/bot${token}/getMe`, { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.username, "pier_bot");
  assert.deepEqual(
    api.calls.map((c) => c.method),
    ["getMe"],
  );
});

test("the fake Deepgram outlives a client that drops in the middle of an upload", async (t) => {
  const deepgram = await fakeDeepgram("hello");
  t.after(() => deepgram.close());
  await dropMidBody(deepgram.url, "/v1/listen");
  assert.equal(deepgram.requests.length, 0);
  const response = await fetch(`${deepgram.url}/listen`, { method: "POST", body: "abc" });
  assert.equal(response.status, 200);
  assert.equal(deepgram.requests.length, 1);
});
