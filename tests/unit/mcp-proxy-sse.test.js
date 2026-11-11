import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import { mcpRoute } from "../../server/features/mcp-servers/mcp-proxy.js";

const proxyModule = new URL(
  "../../server/features/mcp-servers/mcp-proxy.js",
  import.meta.url,
).href;

async function listen(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return server.address().port;
}

/** An SSE server answering with `handler(req, res)`, and the proxy route in front. */
async function proxied(t, handler) {
  const port = await listen(t, handler);
  const route = mcpRoute({
    servers: {
      definition: () => ({
        id: "srv-1",
        name: "docs",
        url: `http://127.0.0.1:${port}/sse`,
        transport: "sse",
        auth: "oauth",
      }),
    },
    oauth: { held: () => true, token: async () => "token-1" },
    authorize: () => true,
  });
  const proxyPort = await listen(t, (req, res) =>
    route(req, res, { scope: ["mcp", "srv-1", "agent-a"], rest: "srv-1", search: "" }),
  );
  return () =>
    fetch(`http://127.0.0.1:${proxyPort}/mcp/srv-1`, {
      headers: { accept: "text/event-stream" },
    });
}

const events = { "content-type": "text/event-stream" };

/** Reads `reader` until `done(bytes)` holds, the stream ends, or `ms` have passed. */
async function readUntil(reader, done, ms = 5000) {
  let bytes = Buffer.alloc(0);
  const deadline = sleep(ms, "timeout", { ref: false });
  while (!done(bytes)) {
    const part = await Promise.race([reader.read(), deadline]);
    if (part === "timeout" || part.done) break;
    bytes = Buffer.concat([bytes, part.value]);
  }
  return bytes;
}

test("an endpoint event that is no URL keeps the proxy and the stream alive", async () => {
  // In a process of its own: an unhandled stream error would end the test runner.
  const script = `
    import http from "node:http";
    import { once } from "node:events";
    import { mcpRoute } from ${JSON.stringify(proxyModule)};
    const upstream = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end("event: endpoint\\ndata: http://[\\n\\nevent: message\\ndata: after\\n\\n");
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    const route = mcpRoute({
      servers: { definition: () => ({ id: "srv-1", name: "docs", transport: "sse",
        auth: "oauth", url: "http://127.0.0.1:" + upstream.address().port + "/sse" }) },
      oauth: { held: () => true, token: async () => "token-1" },
      authorize: () => true,
    });
    const proxy = http.createServer((req, res) =>
      route(req, res, { scope: ["mcp", "srv-1", "agent-a"], rest: "srv-1", search: "" }));
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const url = "http://127.0.0.1:" + proxy.address().port + "/mcp/srv-1";
    const first = await (await fetch(url)).text();
    const second = await (await fetch(url)).text();
    console.log(JSON.stringify({ first, second }));
    process.exit(0);
  `;
  const { stdout } = await new Promise((resolve) =>
    execFile(
      process.execPath,
      ["--input-type=module", "-e", script],
      { timeout: 20_000 },
      (error, stdout, stderr) => {
        assert.equal(error, null, stderr);
        resolve({ stdout });
      },
    ),
  );
  const expected =
    "event: endpoint\ndata: about:blank\n\nevent: message\ndata: after\n\n";
  assert.deepEqual(JSON.parse(stdout), { first: expected, second: expected });
});

test("an event block that never ends reaches the runtime instead of the proxy's memory", async (t) => {
  const size = 8 * 1024 * 1024;
  const call = await proxied(t, async (_req, res) => {
    res.writeHead(200, events);
    res.write("event: message\ndata: ");
    const piece = Buffer.alloc(64 * 1024, "x");
    for (let sent = 0; sent < size; sent += piece.length)
      if (!res.write(piece)) await once(res, "drain");
    // The block stays open: no blank line follows.
  });
  const response = await call();
  const reader = response.body.getReader();
  const bytes = await readUntil(reader, (read) => read.length >= size);
  await reader.cancel();
  assert.ok(bytes.length >= size, `only ${bytes.length} bytes arrived`);
  assert.equal(bytes.subarray(0, 24).toString(), "event: message\ndata: xxx");
});

test("a character split across two chunks of the stream arrives whole", async (t) => {
  const text = 'event: message\r\ndata: {"text":"Grüße, 100 €, 😀"}\r\n\r\n';
  const bytes = Buffer.from(text);
  const call = await proxied(t, async (_req, res) => {
    res.writeHead(200, events);
    res.socket.setNoDelay(true);
    // One byte at a time: every multi-byte character and every CRLF is split.
    for (const byte of bytes) {
      res.write(Buffer.from([byte]));
      await sleep(2);
    }
    res.end();
  });
  const response = await call();
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});

test("an upstream that fails mid-stream ends the response; the proxy keeps serving", async (t) => {
  let requests = 0;
  const call = await proxied(t, async (_req, res) => {
    res.writeHead(200, events);
    if (++requests > 1) return res.end("event: message\ndata: fine\n\n");
    res.write("event: message\ndata: one\n\n");
    await sleep(50);
    res.destroy();
  });
  const response = await call();
  const reader = response.body.getReader();
  const ended = await Promise.race([
    (async () => {
      for (;;) if ((await reader.read()).done) return "ended";
    })().catch(() => "ended"),
    sleep(5000, "open", { ref: false }),
  ]);
  assert.equal(ended, "ended");
  assert.equal(await (await call()).text(), "event: message\ndata: fine\n\n");
});

test("a compressed event stream that is damaged ends the response", async (t) => {
  let requests = 0;
  const call = await proxied(t, (_req, res) => {
    if (++requests > 1)
      return res.writeHead(200, events).end("event: message\ndata: fine\n\n");
    res.writeHead(200, { ...events, "content-encoding": "gzip" });
    const zipped = zlib.gzipSync("event: message\ndata: one\n\n");
    res.end(Buffer.concat([zipped.subarray(0, 12), Buffer.from("not gzip at all")]));
  });
  const response = await call();
  await assert.rejects(response.text());
  assert.equal(await (await call()).text(), "event: message\ndata: fine\n\n");
});

test("a runtime that leaves the stream ends the request to the server", async (t) => {
  let closed;
  const upstreamClosed = new Promise((resolve) => (closed = resolve));
  const call = await proxied(t, (req, res) => {
    res.writeHead(200, events);
    res.write("event: message\ndata: one\n\n");
    res.on("close", closed);
  });
  const response = await call();
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(
    await Promise.race([
      upstreamClosed.then(() => "closed"),
      sleep(5000, "open", { ref: false }),
    ]),
    "closed",
  );
});
