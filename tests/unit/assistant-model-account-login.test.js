import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  AssistantAccountLogin,
  loginReason,
} from "../../server/features/assistants/model-account-login.js";

const deviceUrl = "https://auth.openai.com/codex/device";

/** A Gateway client that answers each method from `script` and records the calls. */
function fakeClient(script) {
  const client = new EventEmitter();
  client.ready = true;
  client.calls = [];
  client.call = async (method, params) => {
    client.calls.push({ method, params });
    const answer = script[method];
    return typeof answer === "function" ? answer(params) : answer;
  };
  return client;
}

function harness(script) {
  const client = fakeClient(script);
  const logs = [];
  const login = new AssistantAccountLogin({
    runtime: { client },
    accounts: { list: async () => [] },
    warn: (line) => logs.push(line),
  });
  return { client, login, logs };
}

async function settle(login, predicate = (s) => s.status !== "starting") {
  for (let i = 0; i < 200; i++) {
    const status = login.status();
    if (predicate(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("login did not settle");
}

const rejected = (code, remoteMessage) => () => {
  throw Object.assign(Error(`Assistant Gateway unavailable (${code}).`), {
    code,
    answered: true,
    ...(remoteMessage ? { remoteMessage } : {}),
  });
};

test("a Gateway that does not offer the device-code login fails as LOGIN_UNAVAILABLE and logs why", async () => {
  const { client, login, logs } = harness({
    "models.authLogin": rejected(
      "INVALID_REQUEST",
      "That provider login is no longer available. Refresh Models and choose an available sign-in option.",
    ),
    "wizard.cancel": {},
  });
  login.start();
  const status = await settle(login);
  assert.deepEqual(
    { status: status.status, diagnostic: status.diagnostic },
    { status: "failed", diagnostic: "LOGIN_UNAVAILABLE" },
  );
  assert.deepEqual(client.calls[0], {
    method: "models.authLogin",
    params: {
      sessionId: status.id,
      agentId: "main",
      authChoice: "openai/openai-device-code",
    },
  });
  assert.equal(logs.length, 1);
  assert.match(
    logs[0],
    /^ChatGPT sign-in failed: LOGIN_UNAVAILABLE \(Gateway INVALID_REQUEST: /,
  );
  assert.match(logs[0], /That provider login is no longer available/);
});

test("the device-code step reaches the browser and a later wizard error is logged without the code", async () => {
  let next = 0;
  const steps = [
    { done: false, status: "running", step: { id: "p", type: "progress" } },
    {
      done: false,
      status: "running",
      step: {
        id: "d",
        type: "progress",
        externalUrl: deviceUrl,
        deviceCode: { code: "ABCD-EFGHI", expiresInMinutes: 15 },
      },
    },
  ];
  let fail = false;
  const { login, logs } = harness({
    "models.authLogin": { done: false, status: "running" },
    "wizard.next": () =>
      fail
        ? {
            done: true,
            status: "error",
            error:
              "Token exchange failed for ABCD-EFGHI with Bearer abc.def access_0123456789abcdefghijklmnop",
          }
        : steps[Math.min(next++, steps.length - 1)],
    "wizard.cancel": {},
  });
  login.start();
  const waiting = await settle(login, (s) => s.status === "awaiting_user");
  assert.equal(waiting.code, "ABCD-EFGHI");
  assert.equal(waiting.url, deviceUrl);
  assert.deepEqual(logs, []);
  fail = true;
  const failed = await settle(login, (s) => s.status === "failed");
  assert.equal(failed.diagnostic, "LOGIN_FAILED");
  assert.equal(failed.code, undefined);
  assert.equal(logs.length, 1);
  assert.match(
    logs[0],
    /^ChatGPT sign-in failed: LOGIN_FAILED \(wizard error: Token exchange failed/,
  );
  assert.doesNotMatch(logs[0], /ABCD-EFGHI|abc\.def|access_0123/);
});

test("an unsupported wizard step and a transport failure keep their own diagnostics", async () => {
  const unsupported = harness({
    "models.authLogin": {},
    "wizard.next": { done: false, step: { id: "s", type: "text", sensitive: false } },
    "wizard.cancel": {},
  });
  unsupported.login.start();
  assert.equal((await settle(unsupported.login)).diagnostic, "UNSUPPORTED_LOGIN_STEP");
  assert.match(unsupported.logs[0], /UNSUPPORTED_LOGIN_STEP \(step text\)/);

  const transport = harness({
    "models.authLogin": () => {
      throw Object.assign(Error("Assistant Gateway unavailable (TIMEOUT)."), {
        code: "TIMEOUT",
      });
    },
    "wizard.cancel": {},
  });
  transport.login.start();
  assert.equal((await settle(transport.login)).diagnostic, "LOGIN_FAILED");
  assert.deepEqual(transport.logs, [
    "ChatGPT sign-in failed: LOGIN_FAILED (Gateway TIMEOUT)",
  ]);
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
