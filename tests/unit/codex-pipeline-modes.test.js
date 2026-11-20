import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cliDefinition } from "../../server/features/clis/catalog.js";
import { nativeCommand } from "../../server/features/pipelines/native-command.js";
import { PipelineDefinitions } from "../../server/features/pipelines/pipeline-definitions.js";

// Codex 0.169.1 accepts only on-request and never as approval policy; "untrusted" made
// every stage of such a profile fail to start (AGENTPIER-427).
test("Codex pipelines offer only the approval policies Codex accepts", () => {
  assert.deepEqual(cliDefinition("codex").pipeline.permissionModes, [
    "on-request",
    "never",
  ]);
});

test("a run that still carries untrusted starts with on-request", () => {
  const command = nativeCommand({
    tool: "codex",
    launch: { command: "codex", args: [], env: {} },
    mode: "untrusted",
    sessionId: "s",
  });
  const policy = command.args.find((arg) => arg.startsWith("approval_policy="));
  assert.equal(policy, 'approval_policy="on-request"');
});

test("stored Codex profiles with untrusted move to on-request once", (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-modes-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const file = path.join(dataDir, "pipelines", "definitions.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const profile = (id, cliTool, mode) => ({
    id,
    name: id,
    enabled: true,
    config: { cliTool, permissions: { mode } },
  });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      profiles: [
        profile("old", "codex", "untrusted"),
        profile("kept", "codex", "never"),
        profile("claude", "claude", "default"),
      ],
      pipelines: [],
      verification: {},
      risk: {},
      queue: {},
      seedsApplied: [],
      seedRevision: 99,
    }),
  );
  const definitions = new PipelineDefinitions({ dataDir, accounts: {} });
  const modes = Object.fromEntries(
    definitions.listProfiles().map((p) => [p.id, p.config.permissions.mode]),
  );
  assert.equal(modes.old, "on-request");
  assert.equal(modes.kept, "never");
  assert.equal(modes.claude, "default");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(
    saved.profiles.find((p) => p.id === "old").config.permissions.mode,
    "on-request",
  );
});
