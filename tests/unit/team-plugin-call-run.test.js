import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../../server/features/assistants/team-plugin/index.js";

// Every AgentPier tool call names its run, as the Gateway's before_tool_call hook
// reported it: a member's report on a turn whose send acknowledgement timed out
// proves that turn as a project call does (run-confirmation.js confirmFromCall).
function tools(t) {
  delete globalThis[Symbol.for("agentpier.execProcesses")];
  const factories = [],
    hooks = [];
  plugin.register({
    pluginConfig: { url: "http://bridge", token: "test" },
    registrationMode: "full",
    registerTool: (f) => factories.push(f),
    on: (name, handler) => hooks.push({ name, handler }),
  });
  const bodies = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    bodies.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => (url.endsWith("/prepare") ? { ticket: "t" } : {}),
    };
  });
  const context = {
    agentId: "agent",
    sessionKey: "session",
    assertInvocationCurrent() {},
  };
  const tool = (name) =>
    factories.map((f) => f.create(context)).find((created) => created?.name === name);
  const before = (toolCallId, runId) => {
    for (const h of hooks.filter((h) => h.name === "before_tool_call"))
      h.handler({ toolName: "x" }, { sessionKey: "session", runId, toolCallId });
  };
  const prepared = () => bodies.filter((b) => b.url.endsWith("/prepare")).at(-1).body;
  return { tool, before, prepared };
}

test("a team report names the run of its tool call", async (t) => {
  const f = tools(t);
  f.before("call-1", "run-1");
  await f.tool("agentpier_team_report").execute("call-1", { text: "Done" });
  assert.equal(f.prepared().runId, "run-1");
  // No call carries the Gateway's record of background commands any more
  // (AGENTPIER-276: a run of the owner's chat needs no proof).
  assert.equal(f.prepared().exec, undefined);
  f.before("call-2", "run-1");
  await f.tool("agentpier_workspace").execute("call-2", { action: "catalog" });
  assert.equal(f.prepared().runId, "run-1");
  assert.equal(f.prepared().exec, undefined);
  // A call the hook never reported names no run.
  await f.tool("agentpier_team_report").execute("call-3", { text: "Done" });
  assert.equal("runId" in f.prepared(), false);
});
