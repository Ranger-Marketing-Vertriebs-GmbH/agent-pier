import test from "node:test";
import assert from "node:assert/strict";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { mcpApplyFixture as fixture, model } from "../helpers/mcp-apply-fixture.js";

// A Hermes agent compiles its bound MCP servers into its own home (assistant-config.js
// applyOwnProcess over mcp-changes.js agentInputs): a change of what it is bound to
// applies that agent, whether or not OpenClaw's Gateway runs.
function hermesFixture(t) {
  const f = fixture(t);
  attachHermesFleet(f.runtime, { available: () => true, close: async () => {} });
  const hermes = f.store.createAssistant({
    name: "Hermes",
    instructions: "",
    model,
    runtime: "hermes",
    capabilities: { memory: false, reminders: false },
  });
  return { ...f, hermes };
}

test("a Hermes agent's bound servers come from the store with their secrets", async (t) => {
  const f = hermesFixture(t);
  const docs = f.http();
  assert.deepEqual(f.changes.agentInputs(f.hermes).servers, []);
  f.changes.setBindings(f.hermes.id, [docs.id]);
  const { servers, inputs } = f.changes.agentInputs(f.hermes);
  assert.deepEqual(servers, [docs.id]);
  assert.equal(inputs.secrets[docs.id].headers.Authorization, "Bearer header-secret");
  // An archived agent is bound to nothing.
  const archived = { ...f.hermes, archivedAt: "2026-11-01T00:00:00.000Z" };
  assert.deepEqual(f.changes.agentInputs(archived).servers, []);
});

test("a change of a Hermes agent's servers applies that agent, once per change", async (t) => {
  const f = hermesFixture(t);
  const home = f.agent("Home");
  const docs = f.http();
  // No OpenClaw Gateway runs: the Hermes agent is applied all the same.
  f.changes.setBindings(f.hermes.id, [docs.id]);
  assert.equal(await f.changes.applySaved(), true);
  assert.deepEqual(f.applied, [f.hermes.id]);
  // Nothing changed for it: no second apply.
  await f.changes.applySaved();
  assert.deepEqual(f.applied, [f.hermes.id]);
  // An edited secret changes what its home holds.
  await f.changes.update(docs.id, {
    revision: 1,
    headers: { Authorization: "Bearer rotated" },
  });
  assert.deepEqual(f.applied, [f.hermes.id, f.hermes.id]);
  // An OpenClaw agent's binding leaves the Hermes agent alone.
  f.changes.setBindings(home.id, [docs.id]);
  await f.changes.applySaved();
  assert.deepEqual(f.applied, [f.hermes.id, f.hermes.id]);
  // A failed apply stays pending and is tried again.
  f.service.config.apply = async () => {
    throw Object.assign(Error("down"), { code: "UNAVAILABLE" });
  };
  f.changes.setBindings(f.hermes.id, []);
  await assert.rejects(f.changes.apply(), (error) => error.code === "UNAVAILABLE");
  assert.equal(f.changes.pending, true);
});

test("a Hermes agent can be bound to an OAuth server: AgentPier's login reaches it", async (t) => {
  const f = hermesFixture(t);
  const oauth = f.servers.create({
    name: "linear",
    transport: "http",
    url: "https://mcp.linear.example/mcp",
    auth: "oauth",
  });
  // Through AgentPier's MCP proxy once AgentPier holds the login (mcp-inputs.js).
  assert.equal(f.changes.checkBindings(f.hermes, [oauth.id]), false);
  const home = f.agent("Home");
  assert.equal(f.changes.checkBindings(home, [oauth.id]), false);
});
