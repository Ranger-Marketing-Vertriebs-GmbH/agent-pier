import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  AssistantAccountLogin,
  loginReason,
} from "../../server/features/assistants/model-account-login.js";
import { ChatGptAuth } from "../../server/features/model-logins/chatgpt-auth.js";
import { ChatGptVault } from "../../server/features/model-logins/chatgpt-vault.js";
import { startFakeChatgptOAuth } from "../helpers/fake-chatgpt.js";

const deviceUrl = "https://auth.openai.com/codex/device";

async function harness(t, { pending = 3, auth: replace } = {}) {
  const issuer = await startFakeChatgptOAuth({ pending });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "chatgpt-login-"));
  const vault = new ChatGptVault({
    dataDir,
    auth: replace || new ChatGptAuth({ issuer: issuer.url }),
    schedule: false,
  });
  const signedIn = [];
  const logs = [];
  const login = new AssistantAccountLogin({
    vault,
    accounts: { signedIn: async (profileId) => signedIn.push(profileId) },
    warn: (line) => logs.push(line),
  });
  t.after(async () => {
    await login.close();
    vault.close();
    await issuer.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { issuer, vault, login, logs, signedIn };
}

async function settle(login, predicate) {
  for (let i = 0; i < 300; i++) {
    const status = login.status();
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`login stayed ${JSON.stringify(login.status())}`);
}

test("AgentPier runs the device-code sign-in itself and keeps the tokens in its vault", async (t) => {
  const { login, vault, signedIn, issuer } = await harness(t);
  const started = login.start();
  assert.equal(login.start().id, started.id, "a running attempt is reused");
  const waiting = await settle(login, (s) => s.status === "awaiting_user");
  assert.equal(waiting.code, "ABCD-EFGHI");
  assert.equal(waiting.url, deviceUrl);
  assert.ok(Date.parse(waiting.expiresAt) > Date.now());
  const done = await settle(login, (s) => s.status === "completed");
  assert.equal(done.code, undefined);
  assert.deepEqual(signedIn, ["openai:owner@example.invalid"]);
  assert.equal(vault.list()[0].status, "ok");
  // The browser never sees a token.
  const pair = vault.records.get("openai:owner@example.invalid");
  assert.ok(!JSON.stringify(done).includes(pair.access));
  assert.equal(issuer.state.calls.filter((c) => c.url === "/oauth/token").length, 1);
});

test("a cancelled sign-in stops polling and stores nothing", async (t) => {
  const { login, vault, issuer } = await harness(t, { pending: 1e6 });
  const { id } = login.start();
  await settle(login, (s) => s.status === "awaiting_user");
  await assert.rejects(login.cancel("another-attempt"), { status: 404 });
  assert.equal((await login.cancel(id)).status, "cancelled");
  const polls = issuer.state.polls;
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(issuer.state.polls <= polls + 1);
  assert.deepEqual(vault.list(), []);
  assert.notEqual(login.start().id, id, "a new attempt after a cancel");
});

test("failures keep their own diagnostics and the log names no code or token", async (t) => {
  const unavailable = await harness(t, {
    auth: {
      startDevice: async () => {
        throw Object.assign(Error(), { code: "LOGIN_UNAVAILABLE" });
      },
    },
  });
  unavailable.login.start();
  const status = await settle(unavailable.login, (s) => s.status === "failed");
  assert.equal(status.diagnostic, "LOGIN_UNAVAILABLE");
  assert.deepEqual(unavailable.logs, ["ChatGPT sign-in failed: LOGIN_UNAVAILABLE"]);

  const rejected = await harness(t, {
    auth: {
      startDevice: async () => ({
        deviceAuthId: "d",
        userCode: "WXYZ-1234",
        intervalMs: 5,
      }),
      pollDevice: async () => {
        throw Object.assign(Error(), {
          code: "LOGIN_FAILED",
          status: 500,
          reason: "WXYZ-1234 Bearer secret-value",
        });
      },
    },
  });
  rejected.login.start();
  assert.equal(
    (await settle(rejected.login, (s) => s.status === "failed")).diagnostic,
    "LOGIN_FAILED",
  );
  assert.ok(!rejected.logs.join("\n").includes("WXYZ-1234"));
  assert.ok(!rejected.logs.join("\n").includes("secret-value"));

  let polls = 0;
  const flaky = await harness(t, {
    auth: {
      startDevice: async () => ({
        deviceAuthId: "d",
        userCode: "WXYZ-1234",
        intervalMs: 5,
      }),
      pollDevice: async () => {
        if (polls++ < 2) throw Object.assign(Error(), { code: "NETWORK" });
        return null;
      },
    },
  });
  flaky.login.start();
  await settle(flaky.login, () => polls > 3);
  assert.equal(
    flaky.login.status().status,
    "awaiting_user",
    "network errors are retried",
  );
});

test("loginReason drops device codes, bearer values, token-like runs and control characters", () => {
  assert.equal(loginReason(undefined), "");
  assert.equal(
    loginReason("Code WXYZ-1234 and Q7RT\nBearer secret-value", "Q7RT"),
    "Code [redacted] and [redacted] Bearer [redacted]",
  );
  assert.equal(loginReason("x".repeat(30)), "[redacted]");
  assert.equal(loginReason("a".repeat(20) + " ".repeat(400)).length, 300);
});
