import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import WebSocket from "ws";
import { createCodexProxy } from "../../server/features/requests/codex-proxy.js";

async function fixture(t) {
  const incoming = new PassThrough(),
    outgoing = new PassThrough();
  const written = [],
    asks = new Map();
  outgoing.on("data", (chunk) =>
    written.push(...String(chunk).trim().split("\n").map(JSON.parse)),
  );
  const channel = {
    publish: (key, view, deliver) => asks.set(key, { view, deliver }),
    resolve: (key) => asks.delete(key),
    close() {},
  };
  const proxy = await createCodexProxy({ input: incoming, output: outgoing, channel });
  t.after(async () => {
    await proxy.close();
    incoming.destroy();
    outgoing.destroy();
  });
  assert.equal(
    new URL(proxy.url).pathname,
    "/",
    "native Codex rejects remote URLs with a path",
  );
  assert.match(proxy.authToken, /^[a-f0-9]{64}$/);
  const tui = new WebSocket(proxy.url, {
    headers: { Authorization: `Bearer ${proxy.authToken}` },
  });
  await once(tui, "open");
  t.after(() => tui.terminate());
  return { incoming, outgoing, written, asks, proxy, tui };
}
const question = {
  id: 123,
  method: "item/tool/requestUserInput",
  params: {
    threadId: "thread",
    turnId: "turn",
    itemId: "item",
    questions: [
      {
        id: "native-q",
        header: "Choice",
        question: "Choose?",
        isOther: true,
        isSecret: false,
        options: [{ label: "One", description: "First" }],
      },
    ],
  },
};
async function readFrame(tui, write) {
  const frame = once(tui, "message");
  write();
  return JSON.parse(String((await frame)[0]));
}

test("Codex proxy preserves native TUI traffic and maps a Chat question response to original RPC ID", async (t) => {
  const { incoming, written, asks, tui } = await fixture(t);
  const native = await readFrame(tui, () =>
    incoming.write(JSON.stringify(question) + "\n"),
  );
  assert.deepEqual(native, question);
  assert.equal(asks.size, 1);
  await [...asks.values()][0].deliver({ answers: { q0: ["One"] } });
  assert.deepEqual(written, [
    { id: 123, result: { answers: { "native-q": { answers: ["One"] } } } },
  ]);
  tui.send(
    JSON.stringify({
      id: 123,
      result: { answers: { "native-q": { answers: ["late"] } } },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(written.length, 1);
});
test("Codex native Terminal answers win the native-side race", async (t) => {
  const { incoming, written, asks, tui } = await fixture(t);
  await readFrame(tui, () => incoming.write(JSON.stringify(question) + "\n"));
  const ask = [...asks.values()][0];
  const answer = {
    id: 123,
    result: { answers: { "native-q": { answers: ["Terminal"] } } },
  };
  tui.send(JSON.stringify(answer));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await assert.rejects(ask.deliver({ answers: { q0: ["o0"] } }), { stale: true });
  assert.deepEqual(written, [answer]);
  assert.equal(asks.size, 0);
});
test("Codex app-server auto-resolution expires Chat without fabricating a native answer", async (t) => {
  const { incoming, written, asks, tui } = await fixture(t);
  await readFrame(tui, () => incoming.write(JSON.stringify(question) + "\n"));
  const ask = [...asks.values()][0];
  await readFrame(tui, () =>
    incoming.write(
      JSON.stringify({
        method: "serverRequest/resolved",
        params: { threadId: "thread", requestId: 123 },
      }) + "\n",
    ),
  );
  await assert.rejects(ask.deliver({ answers: { q0: ["o0"] } }), { stale: true });
  assert.deepEqual(written, []);
});
test("Codex proxy rejects connections without its per-launch bearer capability", async (t) => {
  const { proxy } = await fixture(t);
  const wrong = new WebSocket(proxy.url);
  wrong.on("error", () => {});
  await once(wrong, "close");
  assert.equal(wrong.readyState, WebSocket.CLOSED);
});

test("a future native question shape still reaches Terminal when the Chat adapter cannot parse it", async (t) => {
  const { incoming, tui, asks } = await fixture(t);
  const future = {
    id: "future",
    method: "item/tool/requestUserInput",
    params: {
      threadId: "thread",
      questions: [{ id: "q", question: "Future?", options: { future: "shape" } }],
    },
  };
  const received = await readFrame(tui, () =>
    incoming.write(JSON.stringify(future) + "\n"),
  );
  assert.deepEqual(received, future);
  assert.equal(asks.size, 0);
});
