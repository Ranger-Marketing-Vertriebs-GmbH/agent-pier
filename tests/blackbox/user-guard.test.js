import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { signedInUser, upgradeStatus } from "../helpers/users.js";

test("a user reaches only /api/me and no socket", async (t) => {
  const f = await applicationFixture(t);
  const { cookie } = await signedInUser(f);
  const as = (endpoint, options = {}) =>
    f.request(endpoint, { ...options, headers: { cookie, ...options.headers } });
  const unknown = await f.request("/api/does-not-exist");
  assert.equal(unknown.status, 404);
  const body = await unknown.json();
  for (const [method, endpoint] of [
    ["GET", "/api/state"],
    ["GET", "/api/assistants"],
    ["POST", "/api/sessions"],
    ["GET", "/api/inbox/events"],
    ["GET", "/api/operations/backups"],
    ["GET", "/api/meetings"],
  ]) {
    const response = await as(endpoint, {
      method,
      ...(method === "POST" ? { body: {} } : {}),
    });
    assert.equal(response.status, 404, `${method} ${endpoint}`);
    assert.notEqual(response.headers.get("content-type"), "text/event-stream");
    assert.deepEqual(await response.json(), body, `${method} ${endpoint}`);
  }
  // The owner keeps his routes.
  assert.equal((await f.request("/api/state")).status, 200);
  for (const endpoint of [
    "/api/sessions/x/terminal",
    "/api/sessions/x/chat-stream",
    "/api/assistant-conversations/x/stream",
    "/api/assistants/x/browser-stream",
    "/api/dictation/stream",
  ])
    assert.equal(await upgradeStatus(f, endpoint, cookie), 404, endpoint);
});
