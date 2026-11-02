import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ChatGptAuth,
  tokenIdentity,
} from "../../server/features/model-logins/chatgpt-auth.js";
import {
  ChatGptVault,
  chatgptProfileId,
  refreshAt,
} from "../../server/features/model-logins/chatgpt-vault.js";
import { fakeAccess, startFakeChatgptOAuth } from "../helpers/fake-chatgpt.js";

async function fixture(t, options) {
  const issuer = await startFakeChatgptOAuth(options);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-vault-"));
  const auth = new ChatGptAuth({ issuer: issuer.url });
  const warnings = [];
  const open = (extra = {}) =>
    new ChatGptVault({
      dataDir,
      auth,
      schedule: false,
      warn: (line) => warnings.push(line),
      ...extra,
    });
  t.after(async () => {
    await issuer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { issuer, dataDir, auth, open, warnings };
}

test("the device-code sign-in polls until confirmed and exchanges the code once", async (t) => {
  const { issuer, auth } = await fixture(t, { pending: 2 });
  const device = await auth.startDevice();
  assert.deepEqual(device, {
    deviceAuthId: "dev-1",
    userCode: "ABCD-EFGHI",
    intervalMs: 10,
  });
  assert.equal(await auth.pollDevice(device), null);
  assert.equal(await auth.pollDevice(device), null);
  const tokens = await auth.pollDevice(device);
  assert.match(tokens.refresh, /^rt-/);
  assert.equal(tokens.accountId, "acct-fixture");
  assert.equal(tokens.email, "owner@example.invalid");
  assert.equal(tokens.plan, "plus");
  assert.ok(tokens.expires > Date.now());
  const exchange = issuer.state.calls.find((c) => c.url === "/oauth/token");
  const form = new URLSearchParams(exchange.body);
  assert.equal(form.get("client_id"), "app_EMoamEEZ73f0CkXaXp7hrann");
  assert.equal(form.get("redirect_uri"), `${issuer.url}/deviceauth/callback`);
  assert.equal(exchange.headers.originator, "agentpier");
});

test("token claims name the account, plan and residency", () => {
  const access = fakeAccess({ residency: "eu", expires: 2e12 });
  assert.deepEqual(tokenIdentity(access), {
    accountId: "acct-fixture",
    email: "owner@example.invalid",
    plan: "plus",
    residency: "eu",
    expires: 2e12,
  });
  assert.deepEqual(tokenIdentity("not-a-jwt"), {});
});

test("the vault keeps tokens owner-only, lists none and survives a restart", async (t) => {
  const { issuer, dataDir, open } = await fixture(t);
  const vault = open();
  const tokens = { ...issuer.issue(), email: "owner@example.invalid" };
  const profileId = vault.save({
    access: tokens.access_token,
    refresh: tokens.refresh_token,
    expires: Date.now() + 3600_000,
    accountId: "acct-fixture",
    email: "owner@example.invalid",
  });
  assert.equal(profileId, "openai:owner@example.invalid");
  const file = path.join(dataDir, "model-logins", "chatgpt.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(vault.list()).includes(tokens.refresh_token));
  assert.ok(!JSON.stringify(vault.list()).includes(tokens.access_token));
  const access = vault.accessOf(profileId);
  assert.equal(access.access, tokens.access_token);
  assert.equal(access.refresh, undefined);
  const reopened = open();
  assert.deepEqual(reopened.list(), vault.list());
});

test("one refresher: concurrent 401s redeem the refresh token once and save before use", async (t) => {
  const { issuer, open, dataDir } = await fixture(t);
  const vault = open();
  const first = issuer.issue();
  const profileId = vault.save({
    access: first.access_token,
    refresh: first.refresh_token,
    expires: Date.now() + 3600_000,
    email: "owner@example.invalid",
  });
  const changes = [];
  vault.onChange((id) => changes.push(id));
  const results = await Promise.all(
    [1, 2, 3].map(() => vault.credential(profileId, { stale: first.access_token })),
  );
  assert.equal(issuer.state.refreshes, 1);
  assert.ok(results.every((r) => r.access === results[0].access));
  assert.notEqual(results[0].access, first.access_token);
  const saved = JSON.parse(
    fs.readFileSync(path.join(dataDir, "model-logins", "chatgpt.json"), "utf8"),
  );
  assert.equal(saved.logins[0].access, results[0].access);
  assert.notEqual(saved.logins[0].refresh, first.refresh_token);
  // A 401 for an access token already replaced does not refresh again.
  await vault.credential(profileId, { stale: first.access_token });
  assert.equal(issuer.state.refreshes, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(changes, [profileId]);
});

test("a token due within ten minutes is renewed first", async (t) => {
  const { issuer, open } = await fixture(t);
  const vault = open();
  const pair = issuer.issue();
  const profileId = vault.save({
    access: pair.access_token,
    refresh: pair.refresh_token,
    expires: Date.now() + 5 * 60_000,
    email: "owner@example.invalid",
  });
  const credential = await vault.credential(profileId);
  assert.equal(issuer.state.refreshes, 1);
  assert.ok(credential.expires > Date.now() + 30 * 60_000);
});

test("a reused refresh token signs the login out and asks for a new sign-in", async (t) => {
  const { issuer, open, warnings } = await fixture(t);
  const vault = open();
  const pair = issuer.issue();
  // Another refresher redeemed it first.
  issuer.state.valid.delete(pair.refresh_token);
  issuer.state.used.add(pair.refresh_token);
  const profileId = vault.save({
    access: pair.access_token,
    refresh: pair.refresh_token,
    expires: Date.now() + 60_000,
    email: "owner@example.invalid",
  });
  await assert.rejects(vault.credential(profileId), { code: "RELOGIN" });
  assert.equal(vault.view(profileId).status, "relogin");
  assert.equal(vault.accessOf(profileId), null);
  assert.ok(warnings.some((line) => line.includes("refresh_token_reused")));
  assert.ok(!warnings.join("\n").includes(pair.refresh_token));
  assert.equal(vault.remove(profileId), true);
  assert.deepEqual(vault.list(), []);
});

test("renewal times: 30 minutes early or at half the lifetime", () => {
  const issued = 0;
  assert.equal(refreshAt({ issued, expires: 3600_000 }), 1800_000);
  assert.equal(refreshAt({ issued, expires: 864e6 }), 432e6);
  assert.equal(refreshAt({ issued, expires: 864e6 * 20 }), 864e6 * 10);
  assert.equal(
    chatgptProfileId({ accountId: "a" }).startsWith("openai:agentpier-"),
    true,
  );
});
