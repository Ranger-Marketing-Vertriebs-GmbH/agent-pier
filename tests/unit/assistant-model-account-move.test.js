import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AssistantModelAccounts } from "../../server/features/assistants/model-accounts.js";
import { ChatGptVault } from "../../server/features/model-logins/chatgpt-vault.js";
import { ChatGptAuth } from "../../server/features/model-logins/chatgpt-auth.js";
import {
  createBackupKey,
  readBackupKey,
} from "../../server/features/assistants/backup-credentials.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { openClawStore } from "../helpers/openclaw-store.js";
import { startFakeChatgptOAuth } from "../helpers/fake-chatgpt.js";

// A login OpenClaw made before AgentPier held logins, moved on the owner's request.
async function fixture(t, { ready = false } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-move-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const issuer = await startFakeChatgptOAuth();
  t.after(() => issuer.close());
  const pair = issuer.issue();
  const profileId = "openai:owner@example.invalid";
  const { stateDir, read } = openClawStore(t, {
    store: {
      version: 1,
      profiles: {
        [profileId]: {
          type: "oauth",
          provider: "openai",
          access: pair.access_token,
          refresh: pair.refresh_token,
          expires: Date.now() + 3600_000,
          email: "owner@example.invalid",
          displayName: "Personal",
          accountId: "acct-fixture",
          chatgptPlanType: "plus",
        },
      },
    },
  });
  const calls = [];
  const runtime = {
    paths: { state: stateDir },
    client: {
      ready,
      call: async (method) => {
        calls.push(method);
        if (method === "models.authStatus")
          return {
            providers: [
              {
                provider: "openai",
                profiles: Object.entries(read().profiles).map(([id, p]) => ({
                  profileId: id,
                  type: p.type,
                  displayName: p.displayName,
                  status: "ok",
                })),
              },
            ],
          };
        return {};
      },
    },
  };
  const vault = new ChatGptVault({
    dataDir,
    auth: new ChatGptAuth({ issuer: issuer.url }),
    schedule: false,
  });
  const accounts = new AssistantModelAccounts({
    dataDir,
    runtime,
    vault,
    warn: () => {},
  });
  t.after(() => {
    accounts.close();
    vault.close();
  });
  return { dataDir, accounts, vault, read, pair, profileId, runtime, calls, issuer };
}

test("moving a login OpenClaw holds hands its refresh token to AgentPier once", async (t) => {
  const { accounts, vault, read, pair, profileId, runtime, dataDir, issuer } =
    await fixture(t, { ready: true });
  const [account] = await accounts.list();
  assert.equal(account.holder, "openclaw");
  const root = runtimePaths(dataDir).root;
  const snapshot = randomUUID();
  await createBackupKey(root, snapshot);
  await accounts.move(account.id);
  // A rollback can no longer unseal OpenClaw's old copy of the refresh token.
  assert.equal(readBackupKey(root, snapshot), null);
  const stored = read().profiles[profileId];
  assert.equal(stored.refresh, undefined);
  assert.equal(stored.access, pair.access_token);
  assert.equal(vault.records.get(profileId).refresh, pair.refresh_token);
  assert.equal(vault.view(profileId).name, "Personal");
  const [moved] = accounts.capabilities();
  assert.equal(moved.id, account.id, "agents keep their selection");
  assert.equal(moved.holder, "agentpier");
  assert.equal(issuer.state.refreshes, 0, "no renewal was due");
  // Nothing to move twice.
  await assert.rejects(accounts.move(account.id), { status: 400 });
  assert.equal(runtime.client.ready, true);
});

test("a login is not moved while a run uses it, and works while the Gateway is stopped", async (t) => {
  const { accounts, profileId, read, runtime } = await fixture(t, { ready: true });
  const [account] = await accounts.list();
  const lease = await accounts.resolve(account.id, "gpt-5.4");
  await assert.rejects(accounts.move(account.id), { status: 409 });
  lease.release();
  runtime.client.ready = false;
  await accounts.move(account.id);
  assert.equal(read().profiles[profileId].refresh, undefined);
  assert.equal(accounts.holderOf(account.id), "agentpier");
});
