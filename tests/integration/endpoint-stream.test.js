import test from "node:test";
import assert from "node:assert/strict";
import { createUpstreamClient } from "../../server/features/providers/endpoint-stream.js";
import { scriptedUpstream } from "../helpers/scripted-upstream.js";

const fixed = (address) => (_host, options, callback) =>
  options?.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4);

test("streams chunks and reuses the keep-alive connection", async (t) => {
  const up = await scriptedUpstream(t, async (_entry, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n");
    await new Promise((r) => setTimeout(r, 20));
    res.end("data: 2\n\n");
  });
  const client = createUpstreamClient({ baseUrl: `${up.base}/v1` });
  t.after(() => client.close());
  for (let i = 0; i < 2; i++) {
    const response = await client.request({
      path: "/chat/completions",
      body: { a: i },
      headers: {},
    });
    let text = "";
    for await (const chunk of response.chunks) text += chunk;
    assert.equal(text, "data: 1\n\ndata: 2\n\n");
  }
  assert.equal(up.seen[0].url, "/v1/chat/completions");
  assert.equal(
    up.seen[0].remotePort,
    up.seen[1].remotePort,
    "second request reused the socket",
  );
});

test("idle timeout before headers and between chunks carries adapterKind timeout", async (t) => {
  const up = await scriptedUpstream(t, async (entry, res) => {
    if (entry.body.phase === "headers") return; // hang
    res.writeHead(200);
    res.write("data: 1\n\n"); // then hang
  });
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  await assert.rejects(
    client.request({
      path: "/x",
      body: { phase: "headers" },
      headers: {},
      idleTimeoutMs: 80,
    }),
    { adapterKind: "timeout" },
  );
  const response = await client.request({
    path: "/x",
    body: { phase: "chunks" },
    headers: {},
    idleTimeoutMs: 80,
  });
  await assert.rejects(
    async () => {
      for await (const _ of response.chunks);
    },
    { adapterKind: "timeout" },
  );
});

test("an abort with adapterKind network is not reported as a timeout", async (t) => {
  const up = await scriptedUpstream(t, async () => {}); // never answers
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  const controller = new AbortController();
  const pending = client.request({
    path: "/x",
    body: {},
    headers: {},
    signal: controller.signal,
  });
  controller.abort(
    Object.assign(new Error("client disconnected"), { adapterKind: "network" }),
  );
  await assert.rejects(pending, { adapterKind: "network" });
});

test("redirects are returned, not followed; text() is capped", async (t) => {
  const up = await scriptedUpstream(t, async (entry, res) => {
    if (entry.url === "/r")
      return res.writeHead(302, { location: "http://example.com/" }).end();
    res.writeHead(400);
    res.end("x".repeat(2048));
  });
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  assert.equal((await client.request({ path: "/r", body: {}, headers: {} })).status, 302);
  const big = await client.request({ path: "/e", body: {}, headers: {} });
  await assert.rejects(big.text(1024), { adapterKind: "network" });
  assert.equal(up.seen.length, 2);
});

test("each new connection on the same client re-resolves and re-checks the address policy (Review Focus 5)", async (t) => {
  // `connection: close` makes the server end every socket, so the one pooled agent must open a
  // new connection (and run its lookup again) for each request.
  const up = await scriptedUpstream(t, async (_e, res) =>
    res.writeHead(200, { connection: "close" }).end("{}"),
  );
  let address = "127.0.0.1";
  let lookups = 0;
  const port = new URL(up.base).port;
  const client = createUpstreamClient({
    baseUrl: `http://upstream.test:${port}`,
    lookup: (host, options, callback) => {
      lookups += 1;
      fixed(address)(host, options, callback);
    },
  });
  t.after(() => client.close());
  const first = await client.request({ path: "/a", body: {}, headers: {} });
  assert.equal(first.status, 200);
  await first.text(1024);
  assert.equal(lookups, 1);
  address = "0.0.0.0"; // the name now resolves to a forbidden address
  await assert.rejects(client.request({ path: "/a", body: {}, headers: {} }), {
    adapterKind: "network",
  });
  assert.equal(lookups, 2, "the second connection resolved the name again");
  assert.equal(up.seen.length, 1, "nothing reached the forbidden address");
});

test("an IP-literal upstream outside the policy is refused at creation", () => {
  assert.throws(() => createUpstreamClient({ baseUrl: "http://8.8.8.8/v1" }), {
    reason: "notAllowed",
  });
});

test("a path that would leave the configured origin is refused before any request", async (t) => {
  const up = await scriptedUpstream(t, async (_e, res) => res.writeHead(200).end("{}"));
  const client = createUpstreamClient({ baseUrl: `${up.base}/v1` });
  t.after(() => client.close());
  for (const path of ["@evil.test/x", "x", "//evil.test/x", "http://evil.test/x"]) {
    await assert.rejects(
      client.request({ path, body: {}, headers: { authorization: "Bearer secret-key" } }),
      (error) => error.adapterKind === "network" && !error.message.includes("secret-key"),
    );
  }
  assert.equal(up.seen.length, 0);
});

test("errors never echo the key and oversized response headers are refused", async (t) => {
  const up = await scriptedUpstream(t, async (entry, res) => {
    if (entry.url === "/big") res.writeHead(200, { "x-big": "y".repeat(64 * 1024) });
    res.end("{}");
  });
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  await assert.rejects(
    client.request({ path: "/x", body: {}, headers: { "x-api-key": "secret\nkey" } }),
    (error) => error.adapterKind === "network" && !/secret|key/.test(error.message),
  );
  await assert.rejects(client.request({ path: "/big", body: {}, headers: {} }), {
    adapterKind: "network",
  });
  const ok = await client.request({
    path: "/x",
    body: {},
    headers: { "x-api-key": "k1" },
  });
  assert.equal(await ok.text(1024), "{}");
  assert.equal(up.seen.at(-1).headers["x-api-key"], "k1");
  assert.equal(up.seen.at(-1).headers["content-type"], "application/json");
});

test("an abort mid-stream and an early break destroy the upstream socket", async (t) => {
  const up = await scriptedUpstream(t, async (_e, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: 1\n\n"); // then hang
  });
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  const controller = new AbortController();
  const aborted = await client.request({
    path: "/a",
    body: {},
    headers: {},
    signal: controller.signal,
  });
  const iterate = (async () => {
    for await (const _ of aborted.chunks) controller.abort();
  })();
  await assert.rejects(iterate, { adapterKind: "network" });
  const broken = await client.request({ path: "/b", body: {}, headers: {} });
  for await (const _ of broken.chunks) break;
  for (let i = 0; i < 50 && up.openConnections() > 0; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.equal(up.openConnections(), 0);
  assert.ok(up.seen.every((entry) => entry.closed));
});

test("an already aborted signal sends nothing", async (t) => {
  const up = await scriptedUpstream(t, async (_e, res) => res.writeHead(200).end("{}"));
  const client = createUpstreamClient({ baseUrl: up.base });
  t.after(() => client.close());
  const signal = AbortSignal.abort(
    Object.assign(new Error("gone"), { adapterKind: "network" }),
  );
  await assert.rejects(client.request({ path: "/x", body: {}, headers: {}, signal }), {
    message: "gone",
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(up.seen.length, 0);
});

test("a public address over http is refused by the per-connection lookup", async (t) => {
  const client = createUpstreamClient({
    baseUrl: "http://upstream.test:9/v1",
    lookup: fixed("8.8.8.8"),
  });
  t.after(() => client.close());
  await assert.rejects(client.request({ path: "/a", body: {}, headers: {} }), {
    adapterKind: "network",
    code: "EADDRNOTALLOWED",
  });
});
