import test, { mock } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { download } from "../../server/features/operations/releases.js";

// download() accepts HTTPS only; the fake server speaks plain HTTP on loopback.
const loopback = (port) => (url, init) =>
  fetch(
    String(url).replace(/^https:\/\/fixture\.invalid/, `http://127.0.0.1:${port}`),
    init,
  );

async function fakeServer(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return loopback(server.address().port);
}

const payload = Buffer.from(Array.from({ length: 64 * 1024 }, (_, i) => i % 251));
const quick = { idleTimeout: 150, retryDelay: () => 10 };

test("a stalled transfer resumes from the received byte with a range request", async (t) => {
  const requests = [];
  const fetchImpl = await fakeServer(t, (req, res) => {
    requests.push(req.headers.range || null);
    if (requests.length === 1) {
      res.writeHead(200, { "content-length": payload.length, etag: '"v1"' });
      res.write(payload.subarray(0, 20000));
      return; // stalls: no further bytes
    }
    const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range)[1]);
    assert.equal(req.headers["if-range"], '"v1"');
    res.writeHead(206, {
      "content-length": payload.length - start,
      "content-range": `bytes ${start}-${payload.length - 1}/${payload.length}`,
    });
    res.end(payload.subarray(start));
  });
  const bytes = await download("https://fixture.invalid/a", fetchImpl, 1 << 20, quick);
  assert.deepEqual(bytes, payload);
  assert.deepEqual(requests, [null, "bytes=20000-"]);
});

test("a server ignoring the range restarts the transfer from the beginning", async (t) => {
  const ranges = [];
  const fetchImpl = await fakeServer(t, (req, res) => {
    ranges.push(req.headers.range || null);
    res.writeHead(200, { "content-length": payload.length, etag: '"v1"' });
    if (ranges.length === 1) return res.write(payload.subarray(0, 1000));
    res.end(payload);
  });
  const bytes = await download("https://fixture.invalid/b", fetchImpl, 1 << 20, quick);
  assert.deepEqual(bytes, payload);
  assert.deepEqual(ranges, [null, "bytes=1000-"]);
});

for (const [name, headers, resumed] of [
  ["no validator", {}, false],
  ["a weak ETag", { etag: 'W/"v1"' }, false],
  ["Last-Modified", { "last-modified": "Wed, 07 Oct 2026 10:00:00 GMT" }, true],
]) {
  test(`a stalled transfer with ${name} ${resumed ? "resumes" : "restarts"}`, async (t) => {
    const requests = [];
    const fetchImpl = await fakeServer(t, (req, res) => {
      requests.push([req.headers.range || null, req.headers["if-range"] || null]);
      if (requests.length === 1) {
        res.writeHead(200, { "content-length": payload.length, ...headers });
        return res.write(payload.subarray(0, 5000));
      }
      if (req.headers.range) {
        res.writeHead(206, {
          "content-range": `bytes 5000-${payload.length - 1}/${payload.length}`,
        });
        return res.end(payload.subarray(5000));
      }
      res.writeHead(200, headers);
      res.end(payload);
    });
    const bytes = await download("https://fixture.invalid/v", fetchImpl, 1 << 20, quick);
    assert.deepEqual(bytes, payload);
    assert.deepEqual(
      requests[1],
      resumed ? ["bytes=5000-", headers["last-modified"]] : [null, null],
    );
  });
}

test("a 206 that does not continue the received bytes restarts from zero", async (t) => {
  const ranges = [];
  const fetchImpl = await fakeServer(t, (req, res) => {
    ranges.push(req.headers.range || null);
    if (ranges.length === 1) {
      res.writeHead(200, { "content-length": payload.length, etag: '"v1"' });
      return res.write(payload.subarray(0, 5000));
    }
    if (ranges.length === 2) {
      res.writeHead(206, {
        "content-range": `bytes 4000-${payload.length - 1}/${payload.length}`,
      });
      return res.end(payload.subarray(4000));
    }
    res.writeHead(200, { etag: '"v1"' });
    res.end(payload);
  });
  const bytes = await download("https://fixture.invalid/m", fetchImpl, 1 << 20, quick);
  assert.deepEqual(bytes, payload);
  assert.deepEqual(ranges, [null, "bytes=5000-", null]);
});

test("a 416 on resume naming the received length completes the download", async (t) => {
  const statuses = [];
  const fetchImpl = await fakeServer(t, (req, res) => {
    if (!req.headers.range) {
      statuses.push(200);
      res.writeHead(200, { etag: '"v1"' });
      // Every byte arrives but the response never ends: the transfer stalls.
      return res.write(payload);
    }
    statuses.push(416);
    res.writeHead(416, { "content-range": `bytes */${payload.length}` });
    res.end();
  });
  const bytes = await download("https://fixture.invalid/r", fetchImpl, 1 << 20, quick);
  assert.deepEqual(bytes, payload);
  assert.deepEqual(statuses, [200, 416]);
});

test("a 416 for another length restarts from zero", async (t) => {
  const ranges = [];
  const fetchImpl = await fakeServer(t, (req, res) => {
    ranges.push(req.headers.range || null);
    if (ranges.length === 1) {
      res.writeHead(200, { etag: '"v1"' });
      return res.write(payload.subarray(0, 100));
    }
    if (req.headers.range) {
      res.writeHead(416, { "content-range": "bytes */50" });
      return res.end();
    }
    res.end(payload);
  });
  const bytes = await download("https://fixture.invalid/s", fetchImpl, 1 << 20, quick);
  assert.deepEqual(bytes, payload);
  assert.deepEqual(ranges, [null, "bytes=100-", null]);
});

test("programming errors are not retried", async () => {
  let calls = 0;
  await assert.rejects(
    download(
      "https://fixture.invalid/p",
      async () => {
        calls++;
        throw new TypeError("fetchImpl is broken");
      },
      1024,
      quick,
    ),
    TypeError,
  );
  assert.equal(calls, 1);
});

test("network failures are retried", async () => {
  let calls = 0;
  const bytes = await download(
    "https://fixture.invalid/n",
    async () => {
      if (++calls < 3)
        throw new TypeError("fetch failed", { cause: { code: "ECONNRESET" } });
      return new Response("done");
    },
    1024,
    quick,
  );
  assert.equal(bytes.toString(), "done");
  assert.equal(calls, 3);
});

test("a proxy on a Node without env-proxy support fails fast with a stable code", async () => {
  const { messageIdentity } = await import("../../server/lib/i18n/message-identity.js");
  for (const nodeVersion of ["22.13.0", "22.20.9", "23.11.0"]) {
    const error = await download(
      "https://fixture.invalid/x",
      () => assert.fail("no request may be sent"),
      1024,
      { environment: { https_proxy: "http://proxy:3128" }, nodeVersion },
    ).catch((reason) => reason);
    assert.equal(error.code, "PROXY_REQUIRES_NEWER_NODE");
    assert.match(error.message, /22\.21\.0/);
    assert.deepEqual(messageIdentity(error.message), {
      messageKey: "releases.proxyRequiresNewerNode",
      messageArgs: ["22.21.0"],
    });
  }
  for (const nodeVersion of ["22.21.0", "24.0.0", "26.7.0"])
    assert.equal(
      (
        await download(
          "https://fixture.invalid/y",
          async () => new Response("ok"),
          1024,
          {
            environment: { HTTPS_PROXY: "http://proxy:3128" },
            nodeVersion,
          },
        )
      ).toString(),
      "ok",
    );
  // Without a proxy the Node version is irrelevant.
  assert.equal(
    (
      await download("https://fixture.invalid/z", async () => new Response("ok"), 1024, {
        environment: { NO_PROXY: "example.com" },
        nodeVersion: "22.13.0",
      })
    ).toString(),
    "ok",
  );
});

test("a stalled release channel reports the idle code with a single retry", async (t) => {
  const { Releases } = await import("../../server/features/operations/releases.js");
  const os = await import("node:os");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "release-idle-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let calls = 0;
  const releases = new Releases({
    dataDir,
    channel: "https://channel.invalid/",
    fetchImpl: async () => {
      calls++;
      return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
    },
  });
  const pending = releases.check();
  pending.catch(() => {});
  for (let i = 0; i < 10 && calls < 2; i++) {
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(30000);
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(1000);
  }
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "DOWNLOAD_IDLE_TIMEOUT");
    assert.equal(error.status, 504);
    return true;
  });
  assert.equal(calls, 2);
});

test("a download fails after three retries of an idle transfer", async (t) => {
  let calls = 0;
  const fetchImpl = await fakeServer(t, (_req, res) => {
    calls++;
    res.writeHead(200, { "content-length": payload.length });
    res.write(payload.subarray(0, 10));
  });
  await assert.rejects(download("https://fixture.invalid/c", fetchImpl, 1 << 20, quick), {
    code: "DOWNLOAD_IDLE_TIMEOUT",
  });
  assert.equal(calls, 4);
});

test("server errors are retried with backoff, client errors are not", async (t) => {
  const delays = [];
  let calls = 0;
  const fetchImpl = await fakeServer(t, (req, res) => {
    calls++;
    if (req.url === "/missing") return res.writeHead(404).end();
    if (calls < 3) return res.writeHead(503).end();
    res.end(payload);
  });
  const options = {
    idleTimeout: 1000,
    retryDelay: (attempt) => (delays.push(attempt), 1),
  };
  assert.deepEqual(
    await download("https://fixture.invalid/flaky", fetchImpl, 1 << 20, options),
    payload,
  );
  assert.deepEqual(delays, [0, 1]);
  calls = 0;
  await assert.rejects(
    download("https://fixture.invalid/missing", fetchImpl, 1 << 20, options),
    { status: 404 },
  );
  assert.equal(calls, 1);
});

test("the default backoff grows between the three retries", async () => {
  const { downloadRetryDelay } =
    await import("../../server/features/operations/releases.js");
  assert.deepEqual([0, 1, 2].map(downloadRetryDelay), [1000, 2000, 4000]);
});

test("a slow 50 MB stream at 200 KB/s completes; only 30 s without bytes aborts", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const chunk = Buffer.alloc(200 * 1024, 7);
  const total = 50 * 1024 * 1024;
  let sent = 0;
  const body = new ReadableStream({
    async pull(controller) {
      if (sent >= total) return controller.close();
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const next = chunk.subarray(0, Math.min(chunk.length, total - sent));
      sent += next.length;
      controller.enqueue(next);
    },
  });
  let settled = false;
  const pending = download(
    "https://fixture.invalid/slow",
    async () => new Response(body, { headers: { "content-length": String(total) } }),
    64 * 1024 * 1024,
  ).finally(() => (settled = true));
  let elapsed = 0;
  while (!settled) {
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(1000);
    elapsed += 1000;
    assert.ok(elapsed < 400000, "download did not finish");
  }
  assert.equal((await pending).length, total);
  assert.ok(elapsed > 120000, "the stream must outlast the former total timeout");
});

test("a transfer without bytes for 30 seconds is aborted", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  let calls = 0;
  const pending = download(
    "https://fixture.invalid/idle",
    async () => {
      calls++;
      return new Response(new ReadableStream({ pull: () => new Promise(() => {}) }));
    },
    1024,
    { retries: 0 },
  );
  pending.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  mock.timers.tick(29999);
  await new Promise((resolve) => setImmediate(resolve));
  let rejected = false;
  pending.catch(() => (rejected = true));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejected, false);
  mock.timers.tick(1);
  await assert.rejects(pending, { code: "DOWNLOAD_IDLE_TIMEOUT" });
  assert.equal(calls, 1);
});
