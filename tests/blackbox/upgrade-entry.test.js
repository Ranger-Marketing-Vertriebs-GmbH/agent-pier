import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { randomBytes } from "node:crypto";
import { applicationFixture } from "../helpers/application.js";
import { socketPaths, upgradeTarget } from "../../server/http/socket-access.js";

/**
 * One upgrade request written byte for byte, so the request target reaches the server
 * as given. Resolves the status once the server has closed the socket; a server that
 * neither answers nor closes fails the test.
 */
function rawUpgrade(f, target, { cookie } = {}) {
  const { port } = new URL(f.url);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(port) });
    let answer = "";
    const waiting = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${target}: no answer, socket left open`));
    }, 3000);
    socket.setEncoding("latin1");
    socket.on("data", (chunk) => (answer += chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(waiting);
      resolve({ status: Number(/^HTTP\/1\.1 (\d{3}) /.exec(answer)?.[1]), answer });
    });
    socket.on("connect", () =>
      socket.write(
        [
          `GET ${target} HTTP/1.1`,
          `Host: 127.0.0.1:${port}`,
          "Connection: Upgrade",
          "Upgrade: websocket",
          "Sec-WebSocket-Version: 13",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          ...(cookie ? [`Cookie: ${cookie}`, `Origin: ${f.url}`] : []),
          "",
          "",
        ].join("\r\n"),
      ),
    );
  });
}

const malformed = ["//", "http://[", "//x:99999/"];

test("an upgrade with a malformed request target is refused with 400", async (t) => {
  const f = await applicationFixture(t);
  for (const target of malformed) {
    for (const cookie of [undefined, f.cookie]) {
      const { status, answer } = await rawUpgrade(f, target, { cookie });
      assert.equal(status, 400, target);
      // One answer, although every attacher sees the request.
      assert.equal(answer.match(/HTTP\/1\.1 /g).length, 1, target);
    }
  }
  // The server still answers: nothing above ended the process or the listener.
  assert.equal((await f.request("/api/health")).status, 200);
  assert.equal((await rawUpgrade(f, "/api/live")).status, 403);
});

test("the request target of an upgrade is read once and never throws", () => {
  for (const target of malformed) {
    const written = [];
    const socket = { end: (text) => written.push(text) };
    const req = { url: target };
    assert.equal(upgradeTarget(req, socket), null, target);
    assert.equal(upgradeTarget(req, socket), null, target);
    assert.deepEqual(written, ["HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"]);
  }
  const req = { url: "/api/live?x=1" };
  const socket = { end: () => assert.fail("a valid target is not refused") };
  assert.equal(upgradeTarget(req, socket).pathname, "/api/live");
  assert.equal(upgradeTarget(req, socket), upgradeTarget(req, socket));
});

test("a browser view id beyond its length limit is refused, not left open", async (t) => {
  const f = await applicationFixture(t);
  const endpoint = (length) => `/api/assistants/${"a".repeat(length)}/browser-stream`;
  assert.equal((await rawUpgrade(f, endpoint(101))).status, 403);
  assert.equal((await rawUpgrade(f, endpoint(101), { cookie: f.cookie })).status, 404);
  assert.equal((await rawUpgrade(f, endpoint(5000), { cookie: f.cookie })).status, 404);
  // The longest id is still the browser view's own: no live view runs here.
  assert.equal((await rawUpgrade(f, endpoint(100))).status, 403);
  assert.equal((await rawUpgrade(f, endpoint(100), { cookie: f.cookie })).status, 503);
});

test("an upgrade no attacher takes is answered as before", async (t) => {
  const f = await applicationFixture(t);
  for (const target of [
    "/api/whatever",
    "/whatever",
    "/",
    "*",
    "/api/live/",
    "/api/sessions/a.b/terminal",
    "/api/sessions/a/b/chat-stream",
    "/api/assistant-conversations//stream",
    "/api/assistants//browser-stream",
    "/api/assistants/a.b/browser-stream",
    "/api/dictation/stream/x",
  ]) {
    assert.equal((await rawUpgrade(f, target)).status, 403, target);
    assert.equal((await rawUpgrade(f, target, { cookie: f.cookie })).status, 404, target);
  }
});

test("every socket path answers an upgrade without a login", async (t) => {
  const f = await applicationFixture(t);
  const probes = {
    terminal: "/api/sessions/probe/terminal",
    chat: "/api/sessions/probe/chat-stream",
    "agent-chat": `/api/assistant-conversations/${"a".repeat(300)}/stream`,
    browser: "/api/assistants/probe/browser-stream",
    dictation: "/api/dictation/stream?talk=%",
    live: "/api/live",
  };
  assert.deepEqual(socketPaths.map((p) => p.kind).sort(), Object.keys(probes).sort());
  for (const [kind, target] of Object.entries(probes))
    assert.equal((await rawUpgrade(f, target)).status, 403, kind);
});
