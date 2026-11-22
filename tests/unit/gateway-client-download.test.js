import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import net from "node:net";
import { GatewayClient } from "../../server/features/assistants/runtimes/openclaw/gateway-client.js";
import { issueGatewayCertificate } from "../../server/features/assistants/runtimes/openclaw/gateway-tls.js";

// A pinned HTTPS origin like the Gateway's, serving managed media by path.
async function origin(t, pair = issueGatewayCertificate(), startup = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-download-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const certPath = path.join(directory, "gateway-cert.pem");
  fs.writeFileSync(certPath, pair.cert);
  const seen = [];
  const server = https.createServer(pair, (req, res) => {
    seen.push({ url: req.url, authorization: req.headers.authorization });
    if (req.url === "/startupz" && startup.settled !== undefined)
      return res.writeHead(startup.settled ? 200 : 503).end();
    if (req.url.startsWith("/api/chat/media/outgoing/big")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.alloc(2048));
    }
    if (req.url.startsWith("/api/chat/media/outgoing/")) {
      res.writeHead(200, { "content-type": "image/png" });
      return res.end(Buffer.from("PNGBYTES"));
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const client = new GatewayClient({
    url: `wss://127.0.0.1:${server.address().port}`,
    token: "gateway-token",
    certPath,
  });
  return { client, seen, certPath };
}

test("managed media is read from the pinned Gateway origin without its token", async (t) => {
  const { client, seen } = await origin(t);
  const got = await client.download(
    "/api/chat/media/outgoing/s/i/full?mediaTicket=v1.x",
    {
      maxBytes: 1024,
    },
  );
  assert.equal(got.body.toString(), "PNGBYTES");
  assert.equal(got.type, "image/png");
  assert.equal(seen[0].authorization, undefined);
  await assert.rejects(client.download("/api/missing", { maxBytes: 1024 }), {
    code: "RPC_FAILED",
  });
  await assert.rejects(
    client.download("/api/chat/media/outgoing/big", { maxBytes: 1024 }),
  );
});

test("a start waits for the Gateway's startup check, at most until its deadline", async (t) => {
  const startup = { settled: false };
  const { client, seen } = await origin(t, undefined, startup);
  assert.equal(await client.startupSettled(), false);
  const from = Date.now();
  await client.settleStartup({ deadline: from + 300, pollMs: 50 });
  assert.ok(Date.now() - from >= 250, "it polled until the deadline");
  setTimeout(() => (startup.settled = true), 100);
  await client.settleStartup({ deadline: Date.now() + 5000, pollMs: 50 });
  assert.equal(await client.startupSettled(), true);
  assert.ok(seen.every((r) => r.url === "/startupz" && r.authorization === undefined));
  // A Gateway without the check (404) is settled at once.
  assert.equal(await (await origin(t)).client.startupSettled(), true);
  // So is a listener that never answers, or one the request cannot trust: the wait
  // ends, and nothing is sent to an endpoint with another certificate.
  const sockets = [];
  const quiet = net.createServer((socket) => sockets.push(socket.pause()));
  await new Promise((resolve) => quiet.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    sockets.forEach((socket) => socket.destroy());
    quiet.close();
  });
  const silent = (await origin(t)).client;
  silent.url = `wss://127.0.0.1:${quiet.address().port}`;
  const from2 = Date.now();
  assert.equal(await silent.startupSettled({ timeoutMs: 200 }), true);
  assert.ok(Date.now() - from2 < 2000);
  const other = await origin(t, issueGatewayCertificate(), { settled: false });
  other.client.certPath = (await origin(t)).certPath;
  assert.equal(await other.client.startupSettled(), true);
  assert.deepEqual(other.seen, []);
  // The wait also ends once its start is no longer current.
  const stale = await origin(t, undefined, { settled: false });
  const from3 = Date.now();
  await stale.client.settleStartup({
    deadline: from3 + 5000,
    pollMs: 50,
    live: () => false,
  });
  assert.ok(Date.now() - from3 < 1000);
});

test("a download never leaves the Gateway's origin", async (t) => {
  const { client, seen } = await origin(t);
  for (const target of ["https://example.com/x", "//example.com/x", "x", "", null])
    await assert.rejects(client.download(target, { maxBytes: 1024 }), {
      code: "RPC_FAILED",
    });
  assert.deepEqual(seen, []);
});

test("another certificate on the same address is refused", async (t) => {
  const { client, certPath } = await origin(t);
  fs.writeFileSync(certPath, issueGatewayCertificate().cert);
  await assert.rejects(
    client.download("/api/chat/media/outgoing/s/i/full", { maxBytes: 1024 }),
  );
});
