import test from "node:test";
import assert from "node:assert/strict";
import { paneTarget } from "../../web/features/views/pane-navigation.js";

const s1 = { kind: "session", id: "s1" },
  c1 = { kind: "chat", assistantId: "a1", conversationId: "c1" };

test("a pane keeps its own navigations and hands others on", () => {
  assert.equal(
    paneTarget(s1, { view: "workspace", sessionId: "s1", mode: "files", filePath: "src" })
      .kind,
    "local",
  );
  assert.deepEqual(
    paneTarget(c1, { view: "agents", assistantId: "a1", conversationId: "c2" }),
    { kind: "item", item: { kind: "chat", assistantId: "a1", conversationId: "c2" } },
  );
  assert.equal(
    paneTarget(c1, {
      view: "agents",
      assistantId: "a1",
      conversationId: "c2",
      teamId: "t",
    }).kind,
    "app",
  );
  assert.equal(paneTarget(s1, { view: "workspace", sessionId: "s2" }).kind, "rule");
  assert.equal(paneTarget(s1, { view: "files" }).kind, "app");
  assert.equal(
    paneTarget(c1, { view: "agents", assistantId: "a1", conversationId: "c1" }).kind,
    "local",
  );
  assert.equal(
    paneTarget(c1, { view: "agents", assistantId: "a2", conversationId: "c9" }).kind,
    "rule",
  );
  assert.equal(paneTarget(c1, { view: "workspace", sessionId: "s2" }).kind, "rule");
  assert.equal(
    paneTarget(c1, { view: "agents", assistantId: "a1", agentSettings: true }).kind,
    "app",
  );
});
