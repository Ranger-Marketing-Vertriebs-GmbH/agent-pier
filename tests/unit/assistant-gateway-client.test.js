import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { GatewayClient } from "../../server/features/assistants/gateway-client.js";
import { gatewayFixture } from "../helpers/assistant-gateway-fixture.js";
test("TCP open is not authenticated readiness and RPCs preserve correlation", async (t) => {
  const fixture = await gatewayFixture({ delay: 50 });
  t.after(() => fixture.close());
  const client = new GatewayClient({
    url: fixture.url,
    certPath: fixture.certPath,
    token: "fixture",
  });
  t.after(() => client.close());
  const connecting = client.connect();
  assert.equal(client.ready, false);
  await assert.rejects(client.call("anything", {}), /unavailable/i);
  await connecting;
  assert.equal(client.ready, true);
  assert.deepEqual(await client.call("anything", {}), { value: 42 });
  // An INVALID_REQUEST keeps the Gateway's reason for the caller.
  await assert.rejects(
    client.call("stale", {}),
    (error) =>
      error.code === "INVALID_REQUEST" &&
      error.answered === true &&
      error.remoteMessage === "changed since last load" &&
      error.retryable === undefined,
  );
  // A retryable answer keeps its code and flag: OpenClaw sends it when it did nothing.
  await assert.rejects(
    client.call("busy", {}),
    (error) =>
      error.code === "UNAVAILABLE" &&
      error.answered === true &&
      error.retryable === true &&
      error.remoteMessage === undefined &&
      error.remoteError === undefined,
  );
  // An error OpenClaw's handler threw keeps only its class name, never the text.
  await assert.rejects(
    client.call("refused", {}),
    (error) =>
      error.code === "UNAVAILABLE" &&
      error.answered === true &&
      error.remoteError === "SessionMutationFactsUnavailableError" &&
      error.retryable === undefined &&
      error.remoteMessage === undefined &&
      !JSON.stringify({ ...error, message: error.message }).includes("secret"),
  );
  const waiting = client.call("pending", {});
  client.close();
  await assert.rejects(waiting, /closed/i);
});
test("failed authentication never exposes native error text", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  const client = new GatewayClient({
    url: fixture.url,
    certPath: fixture.certPath,
    token: "wrong",
  });
  t.after(() => client.close());
  await assert.rejects(
    client.connect(),
    (error) =>
      error.code === "UNAUTHORIZED" &&
      error.answered === true &&
      !error.message.includes("secret") &&
      error.remoteMessage === undefined,
  );
  assert.equal(client.ready, false);
  // A local transport failure is never mistaken for a Gateway answer.
  await assert.rejects(
    client.call("agents.list"),
    (error) => error.code === "UNAVAILABLE" && error.answered === undefined,
  );
});

test("reconnecting rejects stale RPCs and authenticates a fresh socket", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  const client = new GatewayClient({
    url: fixture.url,
    certPath: fixture.certPath,
    token: "fixture",
  });
  t.after(() => client.close());
  await client.connect();
  const pending = client.call("pending", {});
  const rejected = assert.rejects(pending, /closed/i);
  client.close();
  await rejected;
  await client.connect();
  assert.deepEqual(await client.call("again", {}), { value: 42 });
});

test("a foreign TLS or TCP listener on the Gateway port never receives the token", async (t) => {
  const pinned = await gatewayFixture({ token: "secret-gateway-token" });
  const foreign = await gatewayFixture({ token: "secret-gateway-token" });
  t.after(() => Promise.all([pinned.close(), foreign.close()]));
  const tls = new GatewayClient({
    url: foreign.url,
    certPath: pinned.certPath,
    token: "secret-gateway-token",
  });
  t.after(() => tls.close());
  await assert.rejects(tls.connect(), { code: "ENDPOINT_UNTRUSTED" });
  assert.deepEqual(foreign.calls, []);

  const received = [];
  const tcp = net.createServer((socket) => socket.on("data", (b) => received.push(b)));
  await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => tcp.close(r)));
  const plain = new GatewayClient({
    url: `wss://127.0.0.1:${tcp.address().port}`,
    certPath: pinned.certPath,
    token: "secret-gateway-token",
    timeoutMs: 300,
  });
  t.after(() => plain.close());
  await assert.rejects(plain.connect());
  assert.equal(Buffer.concat(received).includes("secret-gateway-token"), false);
});

test("unpinned or plain WebSocket endpoints are refused before connecting", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  for (const options of [
    { url: fixture.url.replace("wss:", "ws:"), certPath: fixture.certPath },
    { url: fixture.url },
  ]) {
    const client = new GatewayClient({ ...options, token: "fixture" });
    await assert.rejects(client.connect(), { code: "ENDPOINT_UNTRUSTED" });
    client.close();
  }
  assert.deepEqual(fixture.calls, []);
});

test("the pin is re-read from the certificate file for every connection", async (t) => {
  const original = await gatewayFixture();
  const regenerated = await gatewayFixture();
  t.after(() => Promise.all([original.close(), regenerated.close()]));
  const client = new GatewayClient({
    url: regenerated.url,
    certPath: original.certPath,
    token: "fixture",
  });
  t.after(() => client.close());
  await assert.rejects(client.connect(), { code: "ENDPOINT_UNTRUSTED" });
  fs.copyFileSync(regenerated.certPath, original.certPath);
  await client.connect();
  assert.deepEqual(await client.call("anything", {}), { value: 42 });
});

test("any failure after TCP connect but before the TLS handshake is untrusted", async (t) => {
  const pinned = await gatewayFixture();
  t.after(() => pinned.close());
  const behaviours = [
    (socket) => socket.destroy(),
    (socket) => socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"),
  ];
  for (const behave of behaviours) {
    const sockets = new Set();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      behave(socket);
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    const client = new GatewayClient({
      url: `wss://127.0.0.1:${server.address().port}`,
      certPath: pinned.certPath,
      token: "fixture",
      timeoutMs: 2000,
    });
    t.after(() => {
      client.close();
      for (const socket of sockets) socket.destroy();
      return new Promise((r) => server.close(r));
    });
    await assert.rejects(client.connect(), { code: "ENDPOINT_UNTRUSTED" });
  }
  // Nobody listening yet stays retryable while the Gateway starts.
  const closed = net.createServer();
  await new Promise((r) => closed.listen(0, "127.0.0.1", r));
  const port = closed.address().port;
  await new Promise((r) => closed.close(r));
  const early = new GatewayClient({
    url: `wss://127.0.0.1:${port}`,
    certPath: pinned.certPath,
    token: "fixture",
  });
  const error = await early.connect().catch((value) => value);
  early.close();
  assert.ok(error instanceof Error);
  assert.notEqual(error.code, "ENDPOINT_UNTRUSTED");
});

test("late socket errors of a closed or replaced connection never escape", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  const client = new GatewayClient({
    url: fixture.url,
    certPath: fixture.certPath,
    token: "fixture",
  });
  t.after(() => client.close());
  const escaped = [];
  const record = (error) => escaped.push(error);
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  t.after(() => {
    process.off("uncaughtException", record);
    process.off("unhandledRejection", record);
  });
  // Open, then closed: the old TLS socket errors after the client let it go.
  await client.connect();
  const opened = client.ws;
  client.close();
  opened.emit("error", Object.assign(Error("reset"), { code: "ECONNRESET" }));
  // Connecting, then replaced: the abandoned request's socket errors late.
  const pending = client.connect().catch((error) => error);
  const connecting = client.ws;
  client.ready = false;
  const replacement = client.connect();
  await replacement;
  connecting.emit("error", Object.assign(Error("reset"), { code: "ECONNRESET" }));
  assert.ok((await pending) instanceof Error);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(escaped, []);
  assert.equal(client.ready, true);
  assert.deepEqual(await client.call("anything", {}), { value: 42 });
});

test("the hello's advertised methods and events are recorded", async (t) => {
  const fixture = await gatewayFixture({
    features: { methods: ["config.get"], events: ["chat"] },
  });
  t.after(() => fixture.close());
  const client = new GatewayClient({
    url: fixture.url,
    certPath: fixture.certPath,
    token: "fixture",
  });
  t.after(() => client.close());
  assert.equal(client.supports("config.get"), false);
  await client.connect();
  assert.equal(client.supports("config.get"), true);
  assert.equal(client.supports("web.login.start"), false);
  assert.equal(client.features.events.has("chat"), true);
});

test("a hello without features advertises nothing", async (t) => {
  const fixture = await gatewayFixture();
  t.after(() => fixture.close());
  const client = new GatewayClient({
    url: fixture.url,
    certPath: fixture.certPath,
    token: "fixture",
  });
  t.after(() => client.close());
  await client.connect();
  assert.equal(client.supports("config.get"), false);
});

test("declared client caps reach the handshake and closing forgets the features", async (t) => {
  const fixture = await gatewayFixture({ features: { methods: ["config.get"] } });
  t.after(() => fixture.close());
  const plain = new GatewayClient({
    url: fixture.url,
    certPath: fixture.certPath,
    token: "fixture",
  });
  const approver = new GatewayClient({
    url: fixture.url,
    certPath: fixture.certPath,
    token: "fixture",
    caps: ["exec-approvals"],
  });
  t.after(() => Promise.all([plain.close(), approver.close()]));
  await plain.connect();
  await approver.connect();
  const caps = fixture.calls
    .filter((c) => c.method === "connect")
    .map((c) => c.params.caps);
  assert.deepEqual(caps, [[], ["exec-approvals"]]);
  plain.close();
  assert.equal(plain.features, undefined);
  assert.equal(plain.supports("config.get"), false);
});
