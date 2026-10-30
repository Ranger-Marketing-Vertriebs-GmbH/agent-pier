import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  delegationTools,
  lockedTools,
} from "../../server/features/assistants/native-capabilities.js";
import { teamTools } from "../../server/features/assistants/runtime-config.js";
import {
  actions,
  bridgeTool,
  routineActions,
} from "../../server/features/assistants/team-bridge-actions.js";
import { toolTimeouts } from "../../server/features/assistants/team-plugin/index.js";

const names = ["agentpier_team_groups", "agentpier_team_group_delegate"];

async function registered() {
  const { default: plugin } =
    await import("../../server/features/assistants/team-plugin/index.js");
  const tools = [];
  plugin.register({
    registrationMode: "cli-metadata",
    registerTool: (t) => tools.push(t),
  });
  return Object.fromEntries(
    tools
      .map((tool) => tool.create({ agentId: "a", sessionKey: "s" }))
      .map((tool) => [tool.name, tool]),
  );
}

test("the group tools are a lead's team tools, locked for user agents", () => {
  for (const name of names) {
    assert.ok(delegationTools.includes(name), name);
    assert.ok(teamTools.includes(name), name);
    assert.ok(lockedTools.includes(name), name);
  }
  assert.ok(actions.has("groups") && actions.has("group_delegate"));
  assert.equal(bridgeTool("groups"), "agentpier_team_groups");
  assert.equal(bridgeTool("group_delegate"), "agentpier_team_group_delegate");
  // Never from a routine's own run: its tasks are the routine's, one member each.
  assert.ok(!routineActions.has("groups") && !routineActions.has("group_delegate"));
  assert.equal(toolTimeouts.group_delegate, 30000);
  const manifest = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../server/features/assistants/team-plugin/openclaw.plugin.json",
        import.meta.url,
      ),
    ),
  );
  for (const name of names) assert.ok(manifest.contracts.tools.includes(name), name);
});

test("agentpier_team_groups names every action and documents moves", async () => {
  const tool = (await registered()).agentpier_team_groups;
  const { properties, required, additionalProperties } = tool.parameters;
  assert.deepEqual(required, ["action"]);
  assert.equal(additionalProperties, false);
  assert.deepEqual(properties.action.enum, [
    "list",
    "create",
    "rename",
    "delete",
    "move",
    "ungroup",
  ]);
  assert.equal(properties.name.maxLength, 60);
  assert.equal(properties.groupId.type, "string");
  // A move at any time, directly between groups, and back out of a group.
  assert.match(tool.description, /move \(memberId, groupId\)/);
  assert.match(tool.description, /already in another group/);
  assert.match(tool.description, /in one step/);
  assert.match(tool.description, /ungroup \(memberId\)/);
  assert.match(tool.description, /never interrupts a task/);
});

test("agentpier_team_group_delegate takes a group and a task like a single task", async () => {
  const tools = await registered();
  const tool = tools.agentpier_team_group_delegate;
  const { properties, required } = tool.parameters;
  assert.deepEqual(required, ["groupId", "task"]);
  assert.equal(
    properties.task.maxLength,
    tools.agentpier_team_delegate.parameters.properties.task.maxLength,
  );
  assert.equal(properties.ownerRequested.type, "boolean");
  assert.equal(properties.ownerRequestQuote.maxLength, 300);
  assert.ok(!("memberId" in properties));
  assert.match(tool.description, /GROUP_EMPTY/);
  assert.match(tool.description, /GROUP_MEMBER_BUSY/);
  assert.match(tool.description, /one follow-up with all results/);
});
