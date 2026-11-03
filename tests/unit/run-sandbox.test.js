import test from "node:test";
import assert from "node:assert/strict";
import { CODEX_SANDBOX_MODE, runSandbox } from "../../server/lib/sandbox.js";
import { cliDefinition } from "../../server/features/clis/catalog.js";

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

test("runSandbox reads the native sandbox from the definitions; the shell has none", () => {
  assert.equal(cliDefinition("codex").nativeSandbox, CODEX_SANDBOX_MODE);
  assert.equal(cliDefinition("claude").nativeSandbox, null);
  assert.equal(cliDefinition("opencode").nativeSandbox, null);
  assert.equal(runSandbox("shell"), "none");
  assert.equal(runSandbox(undefined), "none");
  assert.equal(runSandbox("shell", "default"), "nono");
});
