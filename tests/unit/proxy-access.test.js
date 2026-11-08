import test from "node:test";
import assert from "node:assert/strict";
import { proxyAccess } from "../../server/features/assistants/proxy-access.js";
import { accountIdOf } from "../../server/features/assistants/model-accounts.js";

// Who may use a runtime proxy credential, read from the current store at every call.
function fixture() {
  const login = "openai:owner@example.invalid";
  const otherLogin = "openai:second@example.invalid";
  const agents = [
    {
      id: "a1",
      runtimeAgentId: "h-a",
      runtime: "hermes",
      model: { connectionId: accountIdOf(login) },
    },
    {
      id: "a2",
      runtimeAgentId: "h-b",
      runtime: "hermes",
      model: { connectionId: accountIdOf(otherLogin) },
    },
    {
      id: "a3",
      runtimeAgentId: "h-user",
      runtime: "hermes",
      userId: "u1",
      model: { connectionId: accountIdOf(login) },
    },
    { id: "o1", runtimeAgentId: "oc-1", model: { connectionId: accountIdOf(login) } },
  ];
  const bindings = { a1: ["srv"], o1: ["srv"] };
  const users = { u1: true };
  const shares = {};
  const assistants = {
    store: { listAssistants: () => agents },
    userActive: (id) => users[id] === true,
    workflows: { shares: { mcpBindings: () => shares } },
  };
  const servers = { bindingsByTarget: () => bindings };
  const access = proxyAccess({ assistants, servers, accountIdOf });
  return { access, agents, assistants, bindings, users, shares, login, otherLogin };
}

test("a ChatGPT credential works only for the agent whose current model is that login", () => {
  const { access, agents, users, login, otherLogin } = fixture();
  assert.equal(access.chatgpt("h-a", login), true);
  // Another agent, or another login, is refused.
  assert.equal(access.chatgpt("h-b", login), false);
  assert.equal(access.chatgpt("h-a", otherLogin), false);
  // An OpenClaw agent never uses the proxy for ChatGPT.
  assert.equal(access.chatgpt("oc-1", login), false);
  // A user's agent while its user is active; a disabled user's agent is refused.
  assert.equal(access.chatgpt("h-user", login), true);
  users.u1 = false;
  assert.equal(access.chatgpt("h-user", login), false);
  // A changed selection revokes the old credential at once.
  agents[0].model = { connectionId: "endpoint-1" };
  assert.equal(access.chatgpt("h-a", login), false);
  agents[0].model = { connectionId: accountIdOf(login) };
  // Archived and deleted agents are refused.
  agents[0].archivedAt = "2026-11-02T00:00:00Z";
  assert.equal(access.chatgpt("h-a", login), false);
  delete agents[0].archivedAt;
  agents.splice(0, 1);
  assert.equal(access.chatgpt("h-a", login), false);
});

test("an MCP credential works only for agents bound to the server", () => {
  const { access, agents, bindings, shares, users } = fixture();
  assert.equal(access.mcp("srv", "h-a"), true);
  assert.equal(access.mcp("other", "h-a"), false);
  // Another agent, and another user's agent, are not bound.
  assert.equal(access.mcp("srv", "h-b"), false);
  assert.equal(access.mcp("srv", "h-user"), false);
  // Bound through its lead: allowed while the share lasts.
  shares.a2 = ["srv"];
  assert.equal(access.mcp("srv", "h-b"), true);
  delete shares.a2;
  bindings.a3 = ["srv"];
  assert.equal(access.mcp("srv", "h-user"), true);
  users.u1 = false;
  assert.equal(access.mcp("srv", "h-user"), false);
  // Unbinding revokes at once.
  bindings.a1 = [];
  assert.equal(access.mcp("srv", "h-a"), false);
  // The Gateway's credential: while an active OpenClaw agent is bound.
  assert.equal(access.mcp("srv", "openclaw"), true);
  agents.find((a) => a.id === "o1").archivedAt = "2026-11-02T00:00:00Z";
  assert.equal(access.mcp("srv", "openclaw"), false);
  // A Hermes agent's binding does not open the Gateway's credential.
  bindings.a1 = ["srv"];
  assert.equal(access.mcp("srv", "openclaw"), false);
  // A deleted agent is refused.
  agents.splice(0, 1);
  assert.equal(access.mcp("srv", "h-a"), false);
});

test("the owner's PDF fallback login serves an agent's pdf tool while it reads PDFs", () => {
  const { access, agents, assistants, otherLogin } = fixture();
  agents[0].capabilities = { readPdfs: true };
  let fallback = { connectionId: accountIdOf(otherLogin), modelId: "gpt-5.4" };
  assistants.pdfPolicy = { fallback: () => fallback };
  assert.equal(access.chatgpt("h-a", otherLogin), true);
  // Never its images endpoints, and never once the owner chose another fallback or
  // the agent may no longer read PDFs.
  assert.equal(access.chatgpt("h-a", otherLogin, { images: true }), false);
  fallback = null;
  assert.equal(access.chatgpt("h-a", otherLogin), false);
  fallback = { connectionId: accountIdOf(otherLogin), modelId: "gpt-5.4" };
  agents[0].capabilities = { readPdfs: false };
  assert.equal(access.chatgpt("h-a", otherLogin), false);
});
