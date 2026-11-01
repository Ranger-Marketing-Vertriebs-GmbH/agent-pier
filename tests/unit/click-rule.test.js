import test from "node:test";
import assert from "node:assert/strict";
import {
  itemFromRoute,
  itemRoute,
  singleRoute,
} from "../../web/features/views/click-rule.js";

const s1 = { kind: "session", id: "s1" },
  c1 = { kind: "chat", assistantId: "a1", conversationId: "c1" };

test("items map to and from their single-view routes", () => {
  assert.equal(itemRoute(c1), "/agents/a1/chats/c1");
  assert.equal(itemRoute(s1), "/sessions/s1");
  assert.deepEqual(singleRoute(s1, "chat"), {
    view: "workspace",
    sessionId: "s1",
    mode: "reader",
  });
  assert.deepEqual(singleRoute(s1, "files"), {
    view: "workspace",
    sessionId: "s1",
    mode: "files",
  });
  assert.deepEqual(singleRoute(c1), {
    view: "agents",
    assistantId: "a1",
    conversationId: "c1",
  });
  assert.equal(
    itemFromRoute({ view: "agents", assistantId: "a1", agentSettings: true }),
    null,
  );
  assert.equal(
    itemFromRoute({
      view: "agents",
      assistantId: "a1",
      conversationId: "c1",
      teamId: "t",
    }),
    null,
  );
  assert.deepEqual(
    itemFromRoute({ view: "agents", assistantId: "a1", conversationId: "c1" }),
    c1,
  );
  assert.deepEqual(
    itemFromRoute({ view: "workspace", sessionId: "s1", mode: "files" }),
    s1,
  );
  assert.equal(itemFromRoute({ view: "workspace", sessionId: "" }), null);
  assert.equal(itemFromRoute({ view: "files" }), null);
});
