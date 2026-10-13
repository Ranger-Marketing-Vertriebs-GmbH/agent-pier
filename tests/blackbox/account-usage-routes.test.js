import test from "node:test";
import assert from "node:assert/strict";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";

test("accounts usage leaves agent services alone while agents are off", async (t) => {
  const f = await applicationFixture(t);
  assert.equal((await fetch(`${f.url}/api/accounts/usage`)).status, 401);
  const response = await f.request("/api/accounts/usage");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const usage = await response.json();
  assert.equal(usage.agentsEnabled, false);
  assert.equal(usage.webSearch, null);
  assert.equal(usage.speech, null);
  assert.deepEqual(usage.chatgpt, {});
  assert.ok(usage.cliAccounts["local-codex"]);
  assert.equal(usage.cliAccounts["local-codex"].sessions, 0);
  assert.equal(f.application.assistants, null);
});

test("accounts usage names the agents that use an account", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const chatgpt = `openclaw:${"b".repeat(64)}`;
  const agent = f.application.assistants.store.createAssistant({
    name: "Home",
    instructions: "",
    model: { connectionId: chatgpt, modelId: "gpt" },
    capabilities: { memory: false, reminders: false },
  });
  const usage = await (await f.request("/api/accounts/usage")).json();
  assert.equal(usage.agentsEnabled, true);
  assert.deepEqual(usage.chatgpt[chatgpt].agents, [
    { id: agent.id, name: "Home", kind: "agent", via: "model" },
  ]);
  assert.deepEqual(usage.webSearch.agents, []);
});
