import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AccountStore } from "../../server/features/accounts/account-store.js";
import { nativeCommand } from "../../server/features/pipelines/native-command.js";

for (const [tool, mode] of [
  ["codex", "never"],
  ["claude", "acceptEdits"],
  ["opencode", "auto"],
])
  test(`${tool} profile model overrides use verified gateway context without mutating the account or exposing keys`, (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-profile-model-"));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const cli = path.join(root, "version-fixture");
    fs.writeFileSync(cli, "#!/bin/sh\nprintf '2.1.263\\n'\n", { mode: 0o700 });
    const accounts = new AccountStore({ dataDir: root, home: root });
    const provider = { id: "openrouter", modelId: "anthropic/claude-sonnet-4.6" };
    const account = accounts.create({
      name: "Profile",
      tool,
      apiKey: "fixture-secret",
      provider,
    });
    const launch = accounts.command(account.id, { [tool]: cli }, false, "default", {
      modelId: "z-ai/glm-5.3",
    });
    const native = nativeCommand({
      tool,
      mode,
      launch,
      sessionId: "turn",
      headless: true,
    });
    assert.equal(native.provider.requestedModelId, "z-ai/glm-5.3");
    assert.deepEqual(accounts.get(account.id).provider, provider);
    assert.equal(JSON.stringify(native.args).includes("fixture-secret"), false);
    assert.equal(JSON.stringify(native.provider).includes("fixture-secret"), false);
    if (tool === "claude")
      assert.equal(native.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, "1048576");
    if (tool === "opencode")
      assert.equal(
        JSON.parse(native.env.OPENCODE_CONFIG_CONTENT).provider.openrouter.models[
          "z-ai/glm-5.3"
        ].limit.context,
        1048576,
      );
    assert.throws(
      () =>
        accounts.command(account.id, { [tool]: cli }, false, "default", {
          modelId: "nonexistent-model",
        }),
      /model/i,
    );
    accounts.update(account.id, { name: "Profile", removeApiKey: true });
    assert.throws(
      () =>
        accounts.command(account.id, { [tool]: cli }, false, "default", {
          modelId: "z-ai/glm-5.3",
        }),
      /key/i,
    );
  });
