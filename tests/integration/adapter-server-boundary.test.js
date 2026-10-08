import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { scriptedUpstream } from "../helpers/scripted-upstream.js";
import { TOKEN, authorized } from "../helpers/adapter-fixture.js";
import { startAdapterServer as start } from "../helpers/adapter-process.js";
import {
  hostAllowed,
  requestPath,
} from "../../server/features/adapter-runtime/adapter-http.js";

/** Sends a raw HTTP/1.1 request and resolves the status code and the response text. */
function rawRequest(url, lines, { body = "" } = {}) {
  const { port } = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(port), "127.0.0.1");
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (text += chunk));
    socket.on("error", (error) => (text ? resolve(parse(text)) : reject(error)));
    socket.on("close", () => resolve(parse(text)));
    socket.write(`${lines.join("\r\n")}\r\n\r\n${body}`);
  });
}
const parse = (text) => ({ status: Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1]), text });

test("hostAllowed and requestPath accept only loopback hosts and origin-form targets", () => {
  assert.equal(hostAllowed({ host: "127.0.0.1:4000" }, 4000), true);
  assert.equal(hostAllowed({ host: "localhost:4000" }, 4000), true);
  assert.equal(hostAllowed({ host: "[::1]:4000" }, 4000), true);
  assert.equal(hostAllowed({ host: "127.0.0.1" }, 4000), false);
  assert.equal(hostAllowed({}, 4000), false);
  assert.equal(
    hostAllowed({ host: "127.0.0.1:4000", origin: "http://127.0.0.1:4000" }, 4000),
    false,
  );
  assert.equal(requestPath("/v1/messages?beta=true"), "/v1/messages");
  for (const url of ["http://x/v1/messages", "//evil/v1/messages", "*", "", undefined])
    assert.equal(requestPath(url), null);
});

test("Host must name the loopback listener and Origin is refused", async (t) => {
  const up = await scriptedUpstream(t, () => assert.fail("no upstream call expected"));
  const { url, server } = await start(t, up);
  const { port } = new URL(url);
  const probe = (host, extra = []) =>
    rawRequest(url, [
      "HEAD /api/hello HTTP/1.1",
      `Host: ${host}`,
      ...extra,
      "Connection: close",
    ]);
  for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `LOCALHOST:${port}`])
    assert.equal((await probe(host)).status, 200);
  for (const host of ["evil.example", `evil.example:${port}`, "127.0.0.1:1"])
    assert.equal((await probe(host)).status, 403);
  const withOrigin = await probe(`127.0.0.1:${port}`, ["Origin: http://evil.example"]);
  assert.equal(withOrigin.status, 403);
  const authed = await rawRequest(url, [
    "GET /api/hello HTTP/1.1",
    `Host: evil.example:${port}`,
    `Authorization: Bearer ${TOKEN}`,
  ]);
  assert.equal(authed.status, 403);
  assert.match(authed.text, /permission_error/);
  assert.match(authed.text, /connection: close/i);
  assert.equal(server.snapshot().forbidden, 5);
  assert.deepEqual(server.snapshot().requests, {});
});

test("malformed request targets are 400 after auth, never adapter errors", async (t) => {
  const up = await scriptedUpstream(t, () => assert.fail("no upstream call expected"));
  const { url, server } = await start(t, up);
  const { port } = new URL(url);
  const target = (path, auth = []) =>
    rawRequest(
      url,
      [`POST ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, ...auth, "Content-Length: 2"],
      { body: "{}" },
    );
  const bearer = [`Authorization: Bearer ${TOKEN}`];
  assert.equal((await target("http://[::1")).status, 401);
  for (const path of ["http://[::1", "//evil/v1/messages", "http://x/v1/messages"]) {
    const res = await target(path, bearer);
    assert.equal(res.status, 400);
    assert.match(res.text, /malformed request target/);
  }
  const snapshot = server.snapshot();
  assert.equal(snapshot.errors["adapter.internal"], undefined);
  assert.equal(snapshot.unauthorized, 1);
  assert.deepEqual(snapshot.requests, { other: 3 });
});

test("401 and 404 close the connection without reading the body", async (t) => {
  const up = await scriptedUpstream(t, () => assert.fail("no upstream call expected"));
  const { url } = await start(t, up);
  const denied = await fetch(`${url}/v1/messages`, { method: "POST", body: "{}" });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get("connection"), "close");
  const missing = await fetch(`${url}/v1/models`, { headers: authorized() });
  assert.equal(missing.status, 404);
  assert.equal(missing.headers.get("connection"), "close");
  // A huge announced unauthenticated upload is answered at once, without waiting for it.
  const { port } = new URL(url);
  const res = await rawRequest(url, [
    "POST /v1/messages HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `Content-Length: ${1024 * 1024 * 1024}`,
  ]);
  assert.equal(res.status, 401);
});
