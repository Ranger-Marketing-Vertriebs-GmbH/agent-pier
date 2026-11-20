import test from "node:test";
import assert from "node:assert/strict";
import { outdatedCli } from "../../web/features/chat/cli-version-notice.js";

const tool = (overrides = {}) => ({
  id: "claude",
  installed: true,
  version: "2.1.300",
  minimumVersion: "2.1.329",
  versionStatus: "update-required",
  managedInstall: false,
  installMethod: "homebrew",
  updateCommand: "brew upgrade --cask claude-code",
  ...overrides,
});
const session = (overrides = {}) => ({
  id: "s",
  tool: "claude",
  status: "running",
  cliVersion: "2.1.300",
  ...overrides,
});

test("a running session below its CLI's minimum gets the notice with the way out", () => {
  assert.deepEqual(outdatedCli(session(), tool()), {
    tool: "claude",
    found: "2.1.300",
    required: "2.1.329",
    method: "homebrew",
    command: "brew upgrade --cask claude-code",
  });
  assert.deepEqual(
    outdatedCli(
      session(),
      tool({ installMethod: "npm", updateCommand: "npm install -g x@latest" }),
    ),
    {
      tool: "claude",
      found: "2.1.300",
      required: "2.1.329",
      method: "npm",
      command: "npm install -g x@latest",
    },
  );
  // AgentPier's own installation updates through its dialog, never a command.
  assert.equal(outdatedCli(session(), tool({ managedInstall: true })).method, "managed");
  assert.equal(outdatedCli(session(), tool({ managedInstall: true })).command, null);
  // No method or a method without a command falls back to the generic hint.
  for (const extra of [{ installMethod: undefined }, { updateCommand: undefined }])
    assert.equal(outdatedCli(session(), tool(extra)).method, "unknown");
});

test("no notice for an unknown, current or already updated version", () => {
  for (const cliVersion of [undefined, null, "", "unknown", "2.1.329", "2.1.400"])
    assert.equal(outdatedCli(session({ cliVersion }), tool()), null, String(cliVersion));
  // The installed CLI is current again: the notice goes, the reload picks it up.
  assert.equal(outdatedCli(session(), tool({ version: "2.1.329" })), null);
  // A version still being read keeps the notice.
  assert.ok(outdatedCli(session(), tool({ version: null, versionStatus: "checking" })));
});

test("no notice without a matching CLI with a minimum, or for a stopped session", () => {
  assert.equal(outdatedCli(session(), null), null);
  assert.equal(outdatedCli(null, tool()), null);
  assert.equal(outdatedCli(session({ tool: "codex" }), tool()), null);
  assert.equal(outdatedCli(session(), tool({ minimumVersion: null })), null);
  assert.equal(outdatedCli(session({ status: "stopped" }), tool()), null);
});
