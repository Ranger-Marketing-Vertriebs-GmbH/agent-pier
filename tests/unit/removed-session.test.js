import test from "node:test";
import assert from "node:assert/strict";
import { leavesAfterRemoval } from "../../web/app/removed-session.js";

test("removing a session leaves only the session page that shows it (AGENTPIER-415)", () => {
  assert.equal(leavesAfterRemoval({ view: "workspace", sessionId: "s1" }, "s1"), true);
  assert.equal(
    leavesAfterRemoval({ view: "workspace", sessionId: "s1", mode: "reader" }, "s1"),
    true,
  );
  // A split view, another session and other pages stay where they are.
  assert.equal(leavesAfterRemoval({ view: "split", viewId: "v1" }, "s1"), false);
  assert.equal(leavesAfterRemoval({ view: "workspace", sessionId: "s2" }, "s1"), false);
  assert.equal(leavesAfterRemoval({ view: "workspace", sessionId: "" }, "s1"), false);
  assert.equal(leavesAfterRemoval({ view: "projects" }, "s1"), false);
  assert.equal(leavesAfterRemoval(null, "s1"), false);
});
