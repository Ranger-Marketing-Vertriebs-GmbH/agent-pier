import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantModelAccounts } from "../../server/features/assistants/model-accounts.js";
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-accounts-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const profiles = [
    {
      profileId: "openai:fixture@example.invalid",
      displayName: "Personal",
      type: "oauth",
      status: "ok",
      logoutSupported: true,
      accessToken: "never-public",
    },
  ];
  const calls = [];
  const runtime = {
    client: {
      ready: true,
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "models.authStatus")
          return { providers: [{ provider: "openai", profiles }] };
        if (method === "models.probe") {
          profiles[0].status = "ok";
          return { status: "ok" };
        }
        if (method === "models.authLogout") {
          profiles.splice(0);
          return { ok: true };
        }
        return {};
      },
    },
  };
  return {
    accounts: new AssistantModelAccounts({ dataDir, runtime }),
    runtime,
    profiles,
    calls,
    dataDir,
  };
}
test("accounts expose opaque IDs and pin a selected native profile without copying tokens", async (t) => {
  const { accounts, runtime, profiles } = fixture(t);
  const [account] = await accounts.list();
  assert.equal(account.name, "Personal");
  assert.equal(account.available, true);
  assert.ok(!JSON.stringify(account).includes("never-public"));
  assert.ok(!account.id.includes("fixture@example"));
  const lease = await accounts.resolve(account.id, "gpt-6-astra");
  assert.equal(lease.modelRef, "openai/gpt-6-astra@openai:fixture@example.invalid");
  assert.equal(lease.provider, undefined);
  assert.deepEqual(lease.agentRuntime, { model: "openai/gpt-6-astra", id: "openclaw" });
  await assert.rejects(accounts.logout(account.id), { status: 409 });
  lease.release();
  profiles.splice(0);
  await assert.rejects(accounts.resolve(account.id, "gpt-6-astra"), { status: 400 });
  runtime.client.ready = false;
  await assert.rejects(accounts.resolve(account.id, "gpt-6-astra"), { status: 503 });
});
test("offline cached labels are unavailable and expired credentials get a native probe", async (t) => {
  const { accounts, runtime, profiles, calls, dataDir } = fixture(t);
  const [account] = await accounts.list();
  profiles[0].status = "expired";
  const lease = await accounts.resolve(account.id, "gpt-6-astra");
  lease.release();
  assert.equal(
    calls.find((c) => c.method === "models.probe").params.profileId,
    profiles[0].profileId,
  );
  runtime.client.ready = false;
  const reopened = new AssistantModelAccounts({ dataDir, runtime });
  assert.equal((await reopened.list())[0].available, false);
  assert.equal((await reopened.list())[0].name, "Personal");
});
test("logout addresses only the selected profile and model input cannot replace identity", async (t) => {
  const { accounts, calls } = fixture(t);
  const [account] = await accounts.list();
  await assert.rejects(accounts.resolve(account.id, "gpt-6-astra@other"), {
    status: 400,
  });
  await accounts.logout(account.id);
  assert.deepEqual(calls.find((c) => c.method === "models.authLogout").params, {
    provider: "openai",
    agentId: "main",
    profileIds: ["openai:fixture@example.invalid"],
  });
  assert.deepEqual(await accounts.list(), []);
});

test("removed account identity remains pinned offline across restart without remaining publicly selectable", async (t) => {
  const { accounts, runtime, dataDir } = fixture(t);
  const [account] = await accounts.list();
  await accounts.logout(account.id);
  runtime.client.ready = false;
  const reopened = new AssistantModelAccounts({ dataDir, runtime });
  assert.deepEqual(reopened.offlineSelection(account.id, "gpt-6-astra"), {
    modelRef: "openai/gpt-6-astra@openai:fixture@example.invalid",
    available: false,
  });
  assert.deepEqual(reopened.capabilities(), []);
  assert.throws(() => reopened.offlineSelection(account.id, "gpt-6-astra@other"), {
    status: 400,
  });
});
