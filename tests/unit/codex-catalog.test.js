import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantModelAccounts } from "../../server/features/assistants/model-accounts.js";
import { ChatGptVault } from "../../server/features/model-logins/chatgpt-vault.js";
import { ChatGptAuth } from "../../server/features/model-logins/chatgpt-auth.js";
import {
  CodexCatalog,
  parseCodexModels,
} from "../../server/features/model-logins/codex-catalog.js";
import { startFakeChatgptOAuth, startFakeCodex } from "../helpers/fake-chatgpt.js";

test("the Codex catalog drops hidden and invalid models and keeps the priority order", () => {
  assert.deepEqual(
    parseCodexModels({
      models: [
        { slug: "gpt-b", priority: 2, display_name: "GPT B" },
        { slug: "gpt-a", priority: 1 },
        { slug: "gpt-hidden", visibility: "hide" },
        { slug: "bad id" },
        { slug: "gpt-a", priority: 0 },
      ],
    }),
    [
      { modelId: "gpt-a", label: "gpt-a" },
      { modelId: "gpt-b", label: "GPT B" },
    ],
  );
  assert.equal(parseCodexModels({}), null);
});

test("with OpenClaw stopped, a held login's model list comes from Codex through AgentPier", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-catalog-"));
  const issuer = await startFakeChatgptOAuth();
  const codex = await startFakeCodex({ models: ["gpt-5.4", "gpt-5.4-mini"] });
  const vault = new ChatGptVault({
    dataDir,
    auth: new ChatGptAuth({ issuer: issuer.url }),
    schedule: false,
  });
  t.after(async () => {
    vault.close();
    await Promise.all([issuer.close(), codex.close()]);
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const pair = issuer.issue();
  const profileId = vault.save({
    access: pair.access_token,
    refresh: pair.refresh_token,
    expires: Date.now() + 3600_000,
    accountId: "acct-fixture",
    email: "owner@example.invalid",
  });
  // OpenClaw is not running at all: no client, no paths.
  const runtime = {};
  let changes = 0;
  const accounts = new AssistantModelAccounts({
    dataDir,
    runtime,
    vault,
    warn: () => {},
    codex: new CodexCatalog({
      vault,
      upstream: codex.url,
      onChange: () => changes++,
      warn: () => {},
    }),
  });
  t.after(() => accounts.close());
  const [account] = await accounts.list();
  assert.equal(account.available, true);
  assert.equal(account.modelCatalog, "failed", "nothing read yet");
  const result = await accounts.refreshModels(account.id);
  assert.deepEqual(result, {
    models: [
      { modelId: "gpt-5.4", label: "gpt-5.4" },
      { modelId: "gpt-5.4-mini", label: "gpt-5.4-mini" },
    ],
    modelCatalog: "ready",
  });
  assert.equal(accounts.capabilities()[0].modelCatalog, "ready");
  assert.ok(changes >= 1);
  const [read] = codex.requests;
  assert.equal(read.url, "/backend-api/codex/models?client_version=0.160.0");
  assert.equal(read.headers.authorization, `Bearer ${pair.access_token}`);
  assert.equal(read.headers["chatgpt-account-id"], "acct-fixture");
  // A revoked token: renewed once and read again.
  codex.reject.add(vault.accessOf(profileId).access);
  await accounts.refreshModels(account.id);
  assert.equal(issuer.state.refreshes, 1);
  assert.equal(accounts.capabilities()[0].modelCatalog, "ready");
  // ensureModels starts no read while the list is fresh.
  const before = codex.requests.length;
  accounts.ensureModels();
  assert.equal(codex.requests.length, before);
});
