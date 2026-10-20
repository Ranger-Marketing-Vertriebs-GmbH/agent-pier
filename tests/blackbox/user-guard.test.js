import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";
import { signedInUser, upgradeStatus } from "../helpers/users.js";

test("a user opens no socket", async (t) => {
  const f = await applicationFixture(t);
  const { cookie } = await signedInUser(f);
  for (const endpoint of [
    "/api/sessions/x/terminal",
    "/api/sessions/x/chat-stream",
    "/api/assistant-conversations/x/stream",
    "/api/assistants/x/browser-stream",
    "/api/dictation/stream",
  ])
    assert.equal(await upgradeStatus(f, endpoint, cookie), 404, endpoint);
});
