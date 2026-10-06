import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fakeEndpoint } from "../helpers/endpoint-servers.js";
import { endpointRequest } from "../../server/features/providers/endpoint-http.js";

async function rawServer(t, handler, create = (h) => http.createServer(h)) {
  const server = create(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      }),
  );
  return server;
}

test("body cap is enforced while streaming chunked responses", async (t) => {
  let closed = false;
  const server = await rawServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(64 * 1024, "x");
    const timer = setInterval(() => response.write(chunk), 1);
    response.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
  });
  const url = `http://127.0.0.1:${server.address().port}/stream`;
  await assert.rejects(endpointRequest({ url, timeoutMs: 5000 }), (error) => {
    assert.equal(error.reason, "tooLarge");
    assert.equal(error.message, "tooLarge");
    return true;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, true);
});

test("timeout is a total deadline, not only an idle timeout", async (t) => {
  const server = await rawServer(t, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const timer = setInterval(() => response.write(" "), 20);
    response.on("close", () => clearInterval(timer));
  });
  const url = `http://127.0.0.1:${server.address().port}/drip`;
  const started = Date.now();
  await assert.rejects(endpointRequest({ url, timeoutMs: 200 }), { reason: "timeout" });
  assert.ok(Date.now() - started < 2000);
});

test("aborted signals reject with reason aborted", async (t) => {
  const server = await fakeEndpoint(t, { "GET /hang": () => "hang" });
  const before = new AbortController();
  before.abort();
  await assert.rejects(
    endpointRequest({
      url: `${server.base}/hang`,
      timeoutMs: 2000,
      signal: before.signal,
    }),
    { reason: "aborted" },
  );
  const during = new AbortController();
  setTimeout(() => during.abort(), 50);
  await assert.rejects(
    endpointRequest({
      url: `${server.base}/hang`,
      timeoutMs: 2000,
      signal: during.signal,
    }),
    { reason: "aborted" },
  );
});

test("header values Node refuses settle at once with reason invalidKey", async (t) => {
  const server = await fakeEndpoint(t, { "GET /ok": () => ({ json: {} }) });
  const signal = new AbortController().signal;
  let added = 0;
  let removed = 0;
  const add = signal.addEventListener.bind(signal);
  const remove = signal.removeEventListener.bind(signal);
  signal.addEventListener = (...args) => (added++, add(...args));
  signal.removeEventListener = (...args) => (removed++, remove(...args));
  for (const key of ["schlüssel-ключ", "key\x7f"]) {
    const started = Date.now();
    await assert.rejects(
      endpointRequest({
        url: `${server.base}/ok`,
        headers: { Authorization: `Bearer ${key}` },
        timeoutMs: 5000,
        signal,
      }),
      (error) => error.reason === "invalidKey" && !error.message.includes(key),
    );
    assert.ok(Date.now() - started < 1000);
  }
  assert.equal(removed, added);
  assert.equal(server.seen.length, 0);
});

test("non-http URLs and unparseable URLs are not allowed", async () => {
  for (const url of ["ftp://127.0.0.1/x", "file:///etc/passwd", "not a url", ""])
    await assert.rejects(endpointRequest({ url, timeoutMs: 200 }), {
      reason: "notAllowed",
    });
});

test("error statuses resolve without leaking bodies into errors", async (t) => {
  const server = await fakeEndpoint(t, {
    "POST /fail": ({ body }) => ({ status: 500, raw: `secret ${body.model}` }),
  });
  const result = await endpointRequest({
    url: `${server.base}/fail`,
    method: "POST",
    body: { model: "m" },
    timeoutMs: 2000,
  });
  assert.deepEqual(result, { status: 500, json: null });
  assert.equal(server.seen[0].headers["content-type"], "application/json");
  assert.deepEqual(server.seen[0].body, { model: "m" });
  await assert.rejects(
    endpointRequest({ url: "http://127.0.0.1:1/refused", timeoutMs: 2000 }),
    (error) => error.reason === "network" && error.message === "network",
  );
});

test("https keeps SNI on the hostname and verifies certificates", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentpier-endpoint-http-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = path.join(directory, "key.pem");
  const cert = path.join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=model.test",
    ],
    { stdio: "ignore" },
  );
  const tls = { key: await readFile(key), cert: await readFile(cert) };
  const names = [];
  let served = false;
  const server = await rawServer(
    t,
    (_request, response) => {
      served = true;
      response.end("{}");
    },
    (handler) =>
      https.createServer(
        {
          ...tls,
          SNICallback: (name, callback) => {
            names.push(name);
            callback(null, null);
          },
        },
        handler,
      ),
  );
  const lookup = async () => [{ address: "127.0.0.1", family: 4 }];
  await assert.rejects(
    endpointRequest({
      url: `https://model.test:${server.address().port}/v1/models`,
      timeoutMs: 2000,
      lookup,
    }),
    { reason: "network" },
  );
  assert.deepEqual(names, ["model.test"]);
  assert.equal(served, false);
});
