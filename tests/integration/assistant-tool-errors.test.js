import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { RequestLedger } from "../../server/features/assistants/request-ledger.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import { assistantProblem } from "../../server/features/assistants/assistant-validation.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";

async function bridgeWith(t, failure) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tool-errors-")),
    store = new AssistantStore({ dataDir }),
    ledger = new RequestLedger(store.db);
  const parent = store.createAssistant({
      name: "Parent",
      model: { connectionId: "c", modelId: "m" },
    }),
    chat = store.saveConversation({ assistantId: parent.id, runtimeSessionKey: "s" });
  ledger.recordAttempt(ledger.accept(chat.id, { clientRequestId: "r", text: "x" }).id);
  const reminders = {
    invoke() {
      throw failure;
    },
  };
  const bridge = new TeamBridge({
    assistants: { store, ledger, reminders, runtime: { client: { ready: true } } },
    teams: {},
  });
  const { url, token } = await bridge.start();
  t.after(async () => {
    await bridge.close();
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const post = async (endpoint, body) =>
    fetch(url + endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const { ticket } = await (
    await post("/prepare", {
      agentId: parent.runtimeAgentId,
      sessionKey: "s",
      toolCallId: "call",
      action: "reminder",
    })
  ).json();
  const response = await post("/invoke", {
    ticket,
    action: "reminder",
    input: { action: "list" },
  });
  return { status: response.status, body: await response.json() };
}
for (const [failure, status, code, reason] of [
  [
    assistantProblem("reminderChannelRequired", 409),
    409,
    "TELEGRAM_NOT_CONNECTED",
    /Telegram/,
  ],
  [assistantProblem("reminderTimezoneRequired"), 400, "INVALID_TIME", /UTC offset/],
  [assistantProblem("invalid"), 400, "INVALID_INPUT", /parameters/],
  [assistantProblem("invalid", 403), 403, "FORBIDDEN", /not permitted/],
  [assistantProblem("notFound", 404), 404, "NOT_FOUND", /catalog|list/],
  [assistantProblem("conflict", 409), 409, "CONFLICT", /current/],
  [assistantProblem("active", 409), 409, "BUSY", /status/],
  [assistantProblem("reminderReviewRequired", 409), 409, "REVIEW_REQUIRED", /owner/],
  [assistantProblem("unavailable", 503), 503, "UNAVAILABLE", /unavailable/],
  [Error("token=sk-secret leaked"), 503, "UNAVAILABLE", /unavailable/],
])
  test(`bridge reports ${code} to the model without internals`, async (t) => {
    const result = await bridgeWith(t, failure);
    assert.equal(result.status, status);
    assert.equal(result.body.error, code);
    assert.match(result.body.reason, reason);
    assert.ok(!JSON.stringify(result.body).includes("sk-secret"));
    assert.ok(!/[äöüß]|Verbinde/.test(result.body.reason), "model reasons are English");
  });

function tool(t, respond) {
  const factories = [];
  plugin.register({
    pluginConfig: { url: "http://bridge", token: "test" },
    registerTool: (f) => factories.push(f),
    on() {},
  });
  t.mock.method(globalThis, "fetch", async (url) =>
    url.endsWith("/prepare")
      ? { ok: true, json: async () => ({ ticket: "t" }) }
      : respond(),
  );
  return factories
    .map((f) => f.create({ agentId: "a", sessionKey: "s", assertInvocationCurrent() {} }))
    .find((x) => x.name === "agentpier_reminder");
}
test("the plugin passes the stable reason to the model", async (t) => {
  const reminder = tool(t, () => ({
    ok: false,
    status: 409,
    json: async () => ({
      error: "TELEGRAM_NOT_CONNECTED",
      reason: "Connect a Telegram chat in the agent settings first.",
    }),
  }));
  await assert.rejects(
    reminder.execute("call", { action: "list" }),
    (error) =>
      /^TELEGRAM_NOT_CONNECTED: Connect a Telegram chat/.test(error.message) &&
      !/unavailable/.test(error.message),
  );
});
test("the plugin reports only transport failures as unavailable", async (t) => {
  const broken = tool(t, () => ({
    ok: false,
    status: 502,
    json: async () => {
      throw SyntaxError("not json");
    },
  }));
  await assert.rejects(broken.execute("call", { action: "list" }), /unavailable/);
  const reminder = tool(t, () => {
    throw TypeError("fetch failed");
  });
  await assert.rejects(reminder.execute("call", { action: "list" }), /unavailable/);
});
