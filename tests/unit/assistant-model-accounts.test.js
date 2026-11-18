import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantModelAccounts } from "../../server/features/assistants/model-accounts.js";
import { ChatGptVault } from "../../server/features/model-logins/chatgpt-vault.js";
import { openClawStore } from "../helpers/openclaw-store.js";
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
    accounts: new AssistantModelAccounts({ dataDir, runtime, sleep: async () => {} }),
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

// An AgentPier-held login: the vault holds it, OpenClaw only an access-only profile.
async function heldFixture(t, { ready = true } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-held-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { stateDir, read } = openClawStore(t);
  const calls = [];
  const runtime = {
    paths: { state: stateDir },
    client: {
      ready,
      call: async (method, params) => {
        calls.push({ method, params });
        if (method === "models.authStatus") {
          const profiles = Object.entries(read()?.profiles || {}).map(
            ([profileId, p]) => ({ profileId, type: p.type, status: "ok" }),
          );
          return { providers: [{ provider: "openai", profiles }] };
        }
        return {};
      },
    },
  };
  const vault = new ChatGptVault({
    dataDir,
    schedule: false,
    auth: { refresh: async () => assert.fail("no refresh") },
  });
  const accounts = new AssistantModelAccounts({ dataDir, runtime, vault });
  t.after(() => {
    accounts.close();
    vault.close();
  });
  return { accounts, vault, runtime, calls, read };
}

test("a held login reaches OpenClaw access-only and works without the Gateway", async (t) => {
  const { accounts, vault, runtime, calls, read } = await heldFixture(t);
  const profileId = vault.save({
    access: "held-access",
    refresh: "held-refresh",
    expires: Date.now() + 3600_000,
    email: "owner@example.invalid",
  });
  await accounts.signedIn(profileId);
  const profile = read().profiles[profileId];
  assert.equal(profile.access, "held-access");
  assert.equal(profile.refresh, undefined);
  assert.deepEqual(calls.find((c) => c.method === "models.authRefresh").params, {
    operation: "update",
    agentId: "main",
  });
  const [account] = accounts.capabilities();
  assert.equal(account.holder, "agentpier");
  assert.ok(!JSON.stringify(accounts.capabilities()).includes("held-refresh"));
  runtime.client.ready = false;
  assert.equal(accounts.capabilities()[0].available, true);
  const lease = await accounts.resolve(account.id, "gpt-6-astra");
  assert.deepEqual(lease.chatgpt, {
    profileId,
    modelId: "gpt-6-astra",
    holder: "agentpier",
  });
  assert.equal(lease.modelRef, `openai/gpt-6-astra@${profileId}`);
  await assert.rejects(accounts.logout(account.id), { status: 409 });
  lease.release();
  await accounts.logout(account.id);
  assert.deepEqual(vault.list(), []);
  assert.equal(read().profiles[profileId], undefined);
  assert.deepEqual(accounts.capabilities(), []);
});

test("a login OpenClaw holds keeps its holder and needs the Gateway", async (t) => {
  const { accounts, runtime } = await heldFixture(t);
  runtime.client.call = async (method) =>
    method === "models.authStatus"
      ? {
          providers: [
            {
              provider: "openai",
              profiles: [{ profileId: "openai:old", type: "oauth", status: "ok" }],
            },
          ],
        }
      : {};
  const [account] = await accounts.list();
  assert.equal(account.holder, "openclaw");
  runtime.client.ready = false;
  assert.equal(accounts.capabilities()[0].available, false);
  await assert.rejects(accounts.resolve(account.id, "gpt-6-astra"), { status: 503 });
});

test("during maintenance a renewal waits for the next Gateway spawn", async (t) => {
  const { accounts, vault, read } = await heldFixture(t, { ready: false });
  let maintenance = true;
  accounts.paused = () => maintenance;
  const profileId = vault.save({
    access: "first-access",
    refresh: "held-refresh",
    expires: Date.now() + 3600_000,
    email: "owner@example.invalid",
  });
  await accounts.sync(profileId);
  assert.equal(read()?.profiles?.[profileId], undefined, "not written while paused");
  // The spawn's syncAll writes it, maintenance or not.
  await accounts.syncAll();
  assert.equal(read().profiles[profileId].access, "first-access");
  maintenance = false;
  vault.save({ ...vault.records.get(profileId), access: "second-access" }, { profileId });
  await accounts.sync(profileId);
  assert.equal(read().profiles[profileId].access, "second-access");
});

// OpenClaw 2026.11.3 removes the profile, then clears the sessions naming it; that
// step is refused while another task still creates an agent's database (a fresh
// Gateway its main agent's, config.apply a new agent's). A refused logout also skips
// reloading the Gateway's auth snapshot, which models.authStatus reads, so the profile
// stays listed there until models.authRefresh (v2.20.0-rc.4). The refusal may come
// before the removal too, while OpenClaw reads each agent's auth store.
const sessionRaceRefusal = () =>
  Object.assign(Error("Assistant Gateway unavailable (UNAVAILABLE)."), {
    code: "UNAVAILABLE",
    status: 503,
    answered: true,
  });
// `profiles` is the Gateway's snapshot that models.authStatus reads; `stored` what
// OpenClaw persisted. The first `times` logouts are refused, after the removal
// (`removes`) or before it.
const refusingLogout = (
  runtime,
  profiles,
  { removes, error = sessionRaceRefusal(), times = Infinity },
) => {
  const call = runtime.client.call;
  const stored = [...profiles];
  const methods = [];
  runtime.client.call = async (method, params) => {
    methods.push(method);
    if (method === "models.authRefresh") {
      profiles.splice(0, profiles.length, ...stored);
      return { refreshed: true };
    }
    if (method !== "models.authLogout" || times-- <= 0) return call(method, params);
    if (removes) stored.splice(0);
    throw error;
  };
  return methods;
};
const count = (methods, name) => methods.filter((m) => m === name).length;

test("a logout refused after OpenClaw removed the profile took effect", async (t) => {
  const { accounts, runtime, profiles } = fixture(t);
  const [account] = await accounts.list();
  const methods = refusingLogout(runtime, profiles, { removes: true });
  assert.deepEqual(await accounts.logout(account.id), []);
  assert.equal(count(methods, "models.authLogout"), 1, "a removal is never repeated");
});

test("a logout refused before OpenClaw removed the profile is repeated", async (t) => {
  const { accounts, runtime, profiles } = fixture(t);
  const [account] = await accounts.list();
  const methods = refusingLogout(runtime, profiles, { removes: false, times: 2 });
  assert.deepEqual(await accounts.logout(account.id), []);
  assert.equal(count(methods, "models.authLogout"), 3);
});

test("a refused logout whose profile OpenClaw still holds stays failed", async (t) => {
  const { accounts, runtime, profiles } = fixture(t);
  const [account] = await accounts.list();
  const methods = refusingLogout(runtime, profiles, { removes: false });
  await assert.rejects(accounts.logout(account.id), { code: "UNAVAILABLE" });
  assert.ok(count(methods, "models.authLogout") > 1);
  assert.ok(count(methods, "models.authLogout") <= 6, "a bounded number of repeats");
  // Only an answered UNAVAILABLE is looked into: a timeout leaves it unknown.
  const timeout = Object.assign(Error("timeout"), { code: "TIMEOUT", status: 503 });
  const timedOut = refusingLogout(runtime, profiles, { removes: true, error: timeout });
  await assert.rejects(accounts.logout(account.id), { code: "TIMEOUT" });
  assert.equal(count(timedOut, "models.authLogout"), 1);
});
