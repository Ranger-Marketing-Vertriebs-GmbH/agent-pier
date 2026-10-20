import test from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { signedInUser, upgradeStatus } from "../helpers/users.js";
import { socketPaths } from "../../server/http/socket-access.js";

// One path per socket kind; the test fails when a kind has none.
const probes = {
  terminal: "/api/sessions/probe/terminal",
  chat: "/api/sessions/probe/chat-stream",
  "agent-chat": "/api/assistant-conversations/probe/stream",
  browser: "/api/assistants/probe/browser-stream",
  dictation: "/api/dictation/stream",
};
// Users dictate with the owner's speech connection; every other kind needs ownership.
const admitted = new Set(["dictation"]);

const opens = (f, endpoint, cookie) =>
  new Promise((resolve, reject) => {
    const socket = new WebSocket(f.url.replace("http", "ws") + endpoint, {
      headers: { cookie, origin: f.url },
    });
    socket.on("open", () => {
      socket.terminate();
      resolve(true);
    });
    socket.on("unexpected-response", (_req, res) => {
      res.destroy();
      reject(new Error(`${endpoint} refused with ${res.statusCode}`));
    });
    socket.on("error", () => {});
  });

test("users are refused on every socket path", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const { cookie } = await signedInUser(f);
  assert.deepEqual(socketPaths.map((p) => p.kind).sort(), Object.keys(probes).sort());
  for (const { kind, pattern } of socketPaths) {
    const endpoint = probes[kind];
    assert.match(endpoint, pattern, kind);
    if (admitted.has(kind)) assert.equal(await opens(f, endpoint, cookie), true, kind);
    else assert.equal(await upgradeStatus(f, endpoint, cookie), 404, kind);
  }
});

test("an unregistered /api upgrade is refused", async (t) => {
  const f = await applicationFixture(t);
  const { cookie } = await signedInUser(f);
  assert.equal(await upgradeStatus(f, "/api/whatever", cookie), 404);
  assert.equal(await upgradeStatus(f, "/api/whatever", f.cookie), 404);
  assert.equal(await upgradeStatus(f, "/api/me/stream", cookie), 404);
});
