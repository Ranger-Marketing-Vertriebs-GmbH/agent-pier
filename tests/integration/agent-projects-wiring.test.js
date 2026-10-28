import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentProjectFixture } from "../helpers/agent-project-fixture.js";
import { shellService } from "../helpers/assistant-shell-service.js";
import { TeamBridge } from "../../server/features/assistants/team-bridge.js";
import {
  actions,
  bridgeTool,
  routineActions,
} from "../../server/features/assistants/team-bridge-actions.js";
import { hookActions } from "../../server/features/assistants/agent-hook-bridge.js";
import { lockedCall } from "../../server/features/users/user-agent-lock.js";
import plugin, {
  toolTimeouts,
} from "../../server/features/assistants/team-plugin/index.js";

// How agentpier_project reaches an agent: the plugin's own tool, its manifest entry,
// the bridge action behind it and one real call through TeamBridge.

const manifest = JSON.parse(
  fs.readFileSync(
    new URL(
      "../../server/features/assistants/team-plugin/openclaw.plugin.json",
      import.meta.url,
    ),
    "utf8",
  ),
);

test("the bridge serves agentpier_project only outside routines and hooks", () => {
  assert.ok(actions.has("project"));
  assert.equal(bridgeTool("project"), "agentpier_project");
  assert.ok(!routineActions.has("project"));
  assert.ok(!hookActions.has("project"));
  assert.ok(manifest.contracts.tools.includes("agentpier_project"));
  assert.equal(toolTimeouts.project, 30000);
  // A user agent's call is refused by its tool name; an own agent's is not.
  const userAccess = { mode: "own", members: [{ userId: "u1", level: "chat" }] };
  assert.equal(lockedCall({ id: "a", userAccess }, bridgeTool("project")), true);
  assert.equal(lockedCall({ id: "a" }, bridgeTool("project")), false);
});

test("the plugin registers agentpier_project as its own tool with a strict schema", () => {
  const registered = new Map();
  plugin.register({
    pluginConfig: { url: "http://bridge.invalid", token: "test" },
    registerTool: (factory, options) => registered.set(options.name, factory),
    on() {},
  });
  // One of the plugin's own tools: never agentpier_team_project.
  assert.ok(registered.has("agentpier_project"));
  assert.ok(!registered.has("agentpier_team_project"));
  const tool = registered
    .get("agentpier_project")
    .create({ agentId: "ap-x", sessionKey: "s", assertInvocationCurrent() {} });
  assert.equal(tool.name, "agentpier_project");
  const p = tool.parameters;
  assert.deepEqual(p.properties.action.enum, ["create", "coding", "list"]);
  assert.deepEqual(p.required, ["action"]);
  assert.equal(p.additionalProperties, false);
  assert.equal(p.properties.name.maxLength, 255);
  assert.equal(p.properties.projectId.maxLength, 100);
  for (const flag of ["git", "coding", "enabled"])
    assert.equal(p.properties[flag].type, "boolean", flag);
  // The three things an agent must know before it creates a project.
  assert.match(tool.description, /owner's default working directory/);
  assert.match(tool.description, /gives you write access/);
  assert.match(tool.description, /agentpier_team_grant/);
});

test("a call through the team bridge creates, switches and lists the agent's project", async (t) => {
  const f = await agentProjectFixture(t);
  const bridge = new TeamBridge({ assistants: f.assistants, teams: {} });
  await bridge.start();
  t.after(() => bridge.close());
  const agentId = f.store.getAssistant(f.id).runtimeAgentId;
  const call = async (input) => {
    await f.invocation();
    const { ticket } = bridge.prepare({
      agentId,
      sessionKey: "session",
      toolCallId: randomUUID(),
      action: "project",
    });
    const result = await bridge.invoke({ ticket, action: "project", input });
    for (const attempt of f.assistants.ledger.pending())
      f.assistants.ledger.transition(attempt.id, "completed");
    return result;
  };
  const created = await call({ action: "create", name: "Shop" });
  assert.equal(created.name, "Shop");
  assert.equal(created.path, path.join(f.parent, "Shop"));
  assert.equal(created.coding, false);
  assert.ok(fs.existsSync(path.join(created.path, ".git")));
  assert.equal(f.workflows.access.get(f.id).projectFiles[created.projectId], "write");
  const switched = await call({
    action: "coding",
    projectId: created.projectId,
    enabled: true,
  });
  assert.equal(switched.coding, true);
  const listed = await call({ action: "list" });
  assert.deepEqual(
    listed.projects.map((p) => [p.projectId, p.name]),
    [[created.projectId, "Shop"]],
  );
});

test("AssistantConfig compiles the tool and its guidance unless the agent faces other people", async (t) => {
  for (const senderFacing of [false, true]) {
    const f = shellService(t, ["Home"]);
    const [home] = f.agents;
    f.config.senderFacing = () => senderFacing;
    await f.config.apply(home.id);
    const agentsMd = f.client.calls
      .filter((c) => c.method === "agents.files.set" && c.params.name === "AGENTS.md")
      .at(-1).params.content;
    const allow = f.live(home).tools.allow;
    assert.equal(
      allow.includes("agentpier_project"),
      !senderFacing,
      String(senderFacing),
    );
    assert.equal(/\n## Projects\n/.test(agentsMd), !senderFacing, String(senderFacing));
  }
});
