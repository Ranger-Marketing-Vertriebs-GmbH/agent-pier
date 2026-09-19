import test from "node:test";
import assert from "node:assert/strict";
import { runSandbox } from "../../server/lib/sandbox.js";

test("runSandbox keeps its existing answers without a sandbox profile", () => {
  assert.equal(runSandbox("codex"), "workspace-write");
  assert.equal(runSandbox("claude"), "none");
  assert.equal(runSandbox("opencode"), "none");
});

test("runSandbox reports nono as the outer boundary when one is set", () => {
  assert.equal(runSandbox("claude", "claude-default"), "nono");
  assert.equal(runSandbox("opencode", "opencode-default"), "nono");
  assert.equal(runSandbox("codex", "codex-default"), "nono");
});
