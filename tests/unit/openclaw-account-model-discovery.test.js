import test from "node:test";
import assert from "node:assert/strict";
import {
  accountAgentIds,
  discoverAccountModels,
  onAccountLogin,
} from "../../server/features/assistants/runtimes/openclaw/account-model-discovery.js";
import { openClawAgents } from "../../server/features/assistants/runtimes/openclaw/openclaw-agents.js";

// A Gateway client that admitted its agents and answers models.list from `answers`
// (one per read, the last repeated); `calls` records every call but the roster reads.
function fakeClient(answers = [{ models: [] }]) {
  const calls = [];
  let read = 0;
  return {
    ready: true,
    calls,
    async call(method, params, options) {
      if (method === "agents.list") return { agents: [] };
      calls.push({ method, params, options });
      if (method === "models.list") return answers[Math.min(read++, answers.length - 1)];
      if (method === "agents.create") return { agentId: "ap-new" };
      return {};
    },
  };
}

const account = "openai/gpt-6.2-astra@openai:owner@example.invalid";

test("an agent pinned to an account's login is found in every roster layout", () => {
  assert.equal(onAccountLogin(account), true);
  assert.equal(onAccountLogin({ primary: account }), true);
  for (const other of [
    "openai/gpt-6.2-astra",
    "ap-c1/fixture-model",
    "anthropic/claude@profile",
    "",
    undefined,
    { primary: "openai/gpt-6-astra" },
  ])
    assert.equal(onAccountLogin(other), false, JSON.stringify(other));
  const entries = {
    main: {},
    "ap-1": { model: account },
    "ap-2": { model: "ap-c1/fixture-model" },
    "ap-3": { model: { primary: account } },
  };
  assert.deepEqual(accountAgentIds({ agents: { entries } }), ["ap-1", "ap-3"]);
  assert.deepEqual(
    accountAgentIds({
      agents: {
        list: [
          { id: "ap-1", model: account },
          { model: account },
          { id: "ap-2", model: "openai/gpt-6-astra" },
        ],
      },
    }),
    ["ap-1"],
  );
  assert.deepEqual(accountAgentIds(null), []);
});

test("each account agent runs its own openai discovery, again while it is pending", async () => {
  const client = fakeClient([
    { models: [], pendingProviders: ["openai"] },
    { models: [{ id: "gpt-6.2-astra", provider: "openai", available: true }] },
  ]);
  await discoverAccountModels(client, ["ap-1", "ap-3"], { pauseMs: 0 });
  assert.deepEqual(
    client.calls.map((c) => [c.method, c.params]),
    ["ap-1", "ap-1", "ap-3"].map((agentId) => [
      "models.list",
      { agentId, provider: "openai", view: "all", refresh: true },
    ]),
  );
});

test("a discovery never rejects and ends at its budget", async () => {
  const failing = {
    ready: true,
    async call(method) {
      if (method === "agents.list") return { agents: [] };
      throw Object.assign(Error("gone"), { code: "CLOSED" });
    },
  };
  await discoverAccountModels(failing, ["ap-1"]);
  let clock = 0;
  const pending = fakeClient([{ models: [], pendingProviders: ["openai"] }]);
  await discoverAccountModels(pending, ["ap-1"], {
    now: () => (clock += 20_000),
    budget: 60_000,
    pauseMs: 0,
  });
  assert.equal(pending.calls.length, 3);
  await discoverAccountModels(null, ["ap-1"]);
  await discoverAccountModels(fakeClient(), []);
});

test("an agent created or moved onto an account's login discovers its models", async () => {
  const client = fakeClient();
  const agents = openClawAgents({ client }, () => client);
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  await agents.create({ name: "ap-new", workspace: "/w", model: account });
  await settle();
  await agents.update({ agentId: "ap-2", name: "Two", model: "ap-c1/fixture-model" });
  await settle();
  await agents.update({ agentId: "ap-3", name: "Three", model: account });
  await settle();
  assert.deepEqual(
    client.calls.filter((c) => c.method === "models.list").map((c) => c.params.agentId),
    ["ap-new", "ap-3"],
  );
});
