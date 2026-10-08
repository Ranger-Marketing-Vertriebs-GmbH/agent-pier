import test from "node:test";
import assert from "node:assert/strict";
import { createUpstreamClient } from "../../server/features/providers/endpoint-stream.js";
import { scriptedUpstream } from "../helpers/scripted-upstream.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await delay(10);
};

test("a slow consumer is not reported as an upstream timeout", async (t) => {
  const up = await scriptedUpstream(t, async (_entry, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 3; i++) {
      res.write(`data: ${i}\n\n`);
      await delay(20);
    }
    res.end();
  });
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  const response = await client.request({
    path: "/s",
    body: {},
    headers: {},
    idleTimeoutMs: 100,
  });
  let text = "";
  for await (const chunk of response.chunks) {
    text += chunk;
    await delay(250); // the consumer holds every chunk longer than the idle timeout
  }
  assert.equal(text, "data: 0\n\ndata: 1\n\ndata: 2\n\n");
});

test("upstream bytes keep a waiting request alive; silence still times out", async (t) => {
  const up = await scriptedUpstream(t, async (_entry, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (let i = 0; i < 6; i++) {
      res.write(`data: ${i}\n\n`);
      await delay(40);
    }
    // then silent
  });
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  const response = await client.request({
    path: "/s",
    body: {},
    headers: {},
    idleTimeoutMs: 120,
  });
  let count = 0;
  await assert.rejects(
    async () => {
      for await (const _ of response.chunks) count += 1;
    },
    { adapterKind: "timeout" },
  );
  assert.ok(count >= 6);
});

test("cancel() releases an unread response and frees its socket", async (t) => {
  const up = await scriptedUpstream(t, async (_entry, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n"); // then hang
  });
  const client = createUpstreamClient({ baseUrl: up.base, maxSockets: 1 });
  t.after(() => client.close());
  const first = await client.request({ path: "/a", body: {}, headers: {} });
  first.cancel();
  const second = await client.request({
    path: "/b",
    body: {},
    headers: {},
    idleTimeoutMs: 1000,
  });
  assert.equal(second.status, 200);
  second.cancel();
  await until(() => up.openConnections() === 0);
  assert.equal(up.openConnections(), 0);
});

test("idle pooled sockets are closed after the free-socket timeout", async (t) => {
  const up = await scriptedUpstream(t, async (entry, res) => {
    if (entry.url === "/slow") {
      res.writeHead(200);
      res.write("a");
      await delay(150); // longer than the pool timeout, shorter than the idle timeout
      return res.end("b");
    }
    res.writeHead(200).end("{}");
  });
  const client = createUpstreamClient({ baseUrl: up.base, freeSocketTimeoutMs: 60 });
  t.after(() => client.close());
  const slow = await client.request({ path: "/slow", body: {}, headers: {} });
  assert.equal(await slow.text(16), "ab", "an active slow stream is not cut");
  const quick = await client.request({ path: "/q", body: {}, headers: {} });
  assert.equal(await quick.text(16), "{}");
  await until(() => up.openConnections() === 0);
  assert.equal(up.openConnections(), 0);
});

test("a pooled socket reset before any answer is retried once on a new socket", async (t) => {
  const served = new Set();
  const up = await scriptedUpstream(t, async (_entry, res) => {
    const socket = res.socket;
    if (served.has(socket)) return socket.destroy(); // stale keep-alive socket
    served.add(socket);
    res.writeHead(200).end("{}");
  });
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  const first = await client.request({ path: "/a", body: {}, headers: {} });
  assert.equal(await first.text(16), "{}");
  const second = await client.request({ path: "/b", body: {}, headers: {} });
  assert.equal(await second.text(16), "{}");
  assert.equal(up.seen.length, 3);
  assert.notEqual(up.seen[1].remotePort, up.seen[2].remotePort);
});

test("close() ends in-flight requests and refuses later ones", async (t) => {
  const up = await scriptedUpstream(t, async () => {}); // never answers
  const client = createUpstreamClient({ baseUrl: up.base });
  const pending = client.request({ path: "/a", body: {}, headers: {} });
  await until(() => up.seen.length === 1);
  client.close();
  await assert.rejects(pending, { adapterKind: "network" });
  await assert.rejects(client.request({ path: "/b", body: {}, headers: {} }), {
    adapterKind: "network",
    message: "upstream client closed",
  });
  await delay(20);
  assert.equal(up.seen.length, 1);
});

test("an undefined body and other schemes are refused with clear errors", async () => {
  const client = createUpstreamClient({ baseUrl: "http://127.0.0.1:9" });
  await assert.rejects(client.request({ path: "/a", headers: {} }), {
    name: "TypeError",
    message: "upstream request body must be JSON",
  });
  client.close();
  for (const baseUrl of ["ftp://127.0.0.1/v1", "file:///tmp/x", "ws://127.0.0.1/"])
    assert.throws(() => createUpstreamClient({ baseUrl }), { reason: "notAllowed" });
});
