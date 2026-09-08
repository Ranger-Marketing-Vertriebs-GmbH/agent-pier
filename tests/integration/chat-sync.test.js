import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture } from "../helpers/application.js";

test("authenticated chat cursors preserve decorated images and never bypass session lookup", async (t) => {
  const f = await applicationFixture(t);
  const session = {
    id: "sync",
    accountId: "local-codex",
    tool: "codex",
    cwd: f.root,
    status: "stopped",
  };
  const snapshot = {
    availability: "ready",
    providerSessionId: "native",
    messages: [{ id: "one", role: "assistant", text: "Preview: result.png" }],
    tasks: [],
  };
  let removed = false;
  f.application.sessions.get = async (id) => {
    if (removed || id !== session.id)
      throw Object.assign(Error("Missing"), { status: 404 });
    return session;
  };
  f.application.chat.read = async () => snapshot;
  const first = await (await f.request("/api/sessions/sync/chat")).json();
  assert.equal(first.sync.mode, "full");
  assert.equal(first.messages[0].images.length, 1);
  assert.equal(first.messages[0].images[0].fullPath, undefined);
  const route = `/api/sessions/sync/chat?cursor=${first.sync.cursor}`;
  const unchanged = await (await f.request(route)).json();
  assert.equal(unchanged.sync.mode, "delta");
  assert.deepEqual(unchanged.upserts, []);
  snapshot.messages[0].text += "\nSecond preview: other.png";
  const updated = await (await f.request(route)).json();
  assert.equal(updated.upserts[0].images.length, 2);
  assert.ok(updated.upserts[0].images.every((image) => !image.fullPath));
  const anonymous = await fetch(f.url + route);
  assert.equal(anonymous.status, 401);
  removed = true;
  assert.equal((await f.request(route)).status, 404);
});
