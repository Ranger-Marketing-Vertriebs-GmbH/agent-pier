import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { AssistantAccountLogin } from "../../server/features/assistants/model-account-login.js";
async function until(predicate) {
  for (let n = 0; n < 100 && !predicate(); n++)
    await new Promise((r) => setTimeout(r, 5));
  assert.ok(predicate());
}
function fixture(steps) {
  const calls = [];
  const client = Object.assign(new EventEmitter(), { ready: true });
  let finish;
  const pending = new Promise((r) => {
    finish = r;
  });
  client.call = async (method, params) => {
    calls.push({ method, params });
    if (method === "models.authLogin")
      return { sessionId: params.sessionId, status: "running", done: false };
    if (method === "wizard.cancel") {
      finish({ done: true, status: "cancelled" });
      return { status: "cancelled" };
    }
    if (method === "wizard.next") return steps.length ? steps.shift() : pending;
    assert.fail(method);
  };
  let lists = 0;
  const accounts = {
    list: async () => {
      lists++;
      return [];
    },
  };
  const login = new AssistantAccountLogin({ runtime: { client }, accounts });
  return { login, calls, client, finish, lists: () => lists };
}
test("device login exposes only an official URL/code and refreshes accounts on completion", async (t) => {
  const f = fixture([
    {
      done: false,
      step: {
        id: "device",
        type: "progress",
        message: "raw secret",
        externalUrl: "https://auth.openai.com/codex/device",
        deviceCode: { code: "ABCD-EFGHI", expiresInMinutes: 15 },
        access_token: "private",
      },
    },
  ]);
  t.after(() => f.login.close());
  const start = f.login.start();
  assert.equal(f.login.start().id, start.id);
  await until(() => f.login.status(start.id).status === "awaiting_user");
  const status = f.login.status(start.id);
  assert.equal(status.code, "ABCD-EFGHI");
  assert.equal(status.url, "https://auth.openai.com/codex/device");
  assert.ok(!JSON.stringify(status).includes("secret"));
  assert.ok(!JSON.stringify(status).includes("private"));
  f.finish({ done: true, status: "done" });
  await until(() => f.login.status(start.id).status === "completed");
  assert.equal(f.login.status(start.id).code, undefined);
  assert.equal(f.lists(), 1);
  assert.equal(f.calls[0].params.authChoice, "openai/openai-device-code");
});
test("unknown sensitive steps fail closed and arbitrary wizard IDs cannot be cancelled", async (t) => {
  const f = fixture([
    {
      done: false,
      step: { id: "bad", type: "text", sensitive: true, message: "Paste refresh token" },
    },
  ]);
  t.after(() => f.login.close());
  const { id } = f.login.start();
  await until(() => f.login.status(id).status === "failed");
  assert.equal(f.login.status(id).diagnostic, "UNSUPPORTED_LOGIN_STEP");
  await assert.rejects(f.login.cancel("another-wizard"), { status: 404 });
  assert.ok(f.calls.some((c) => c.method === "wizard.cancel"));
});
test("connection loss invalidates a login and late completion cannot report success", async (t) => {
  const f = fixture([]);
  t.after(() => f.login.close());
  const { id } = f.login.start();
  await until(() => f.calls.some((c) => c.method === "wizard.next"));
  f.client.ready = false;
  f.client.emit("disconnected");
  f.finish({ done: true, status: "done" });
  await until(() => f.login.status(id).status === "failed");
  assert.equal(f.lists(), 0);
});
test("untrusted login links are never exposed", async (t) => {
  const f = fixture([
    {
      done: false,
      step: {
        id: "bad",
        type: "action",
        externalUrl: "https://example.invalid/steal",
        deviceCode: { code: "ABCD-EFGHI" },
      },
    },
  ]);
  t.after(() => f.login.close());
  const { id } = f.login.start();
  await until(() => f.login.status(id).status === "failed");
  assert.equal(f.login.status(id).url, undefined);
});
test("a stopped Gateway invalidates progress even when close emits no disconnect event", async (t) => {
  const f = fixture([
    {
      done: false,
      step: { id: "progress", type: "progress", deviceCode: { code: "ABCD-EFGHI" } },
    },
  ]);
  t.after(() => f.login.close());
  const first = f.login.start();
  await until(() => f.login.status().status === "awaiting_user");
  f.client.ready = false;
  await f.login.attempt.task;
  assert.equal(f.login.status().status, "failed");
  assert.equal(f.login.status().code, undefined);
  f.client.ready = true;
  assert.notEqual(f.login.start().id, first.id);
});
