import test from "node:test";
import assert from "node:assert/strict";
import {
  lockedTools,
  profileTools,
  routineTools,
} from "../../server/features/assistants/native-capabilities.js";
import {
  actions,
  bridgeTool,
  routineActions,
} from "../../server/features/assistants/team-bridge-actions.js";
import plugin from "../../server/features/assistants/team-plugin/index.js";

test("own agents and permanent members get agentpier_goal, others do not", () => {
  const tools = (a) => profileTools(a, true, true, true);
  assert.ok(tools({ id: "a" }).includes("agentpier_goal"));
  assert.ok(
    tools({ id: "a", teamMemberId: "m", lifetime: "permanent" }).includes(
      "agentpier_goal",
    ),
  );
  assert.ok(
    !tools({ id: "a", teamMemberId: "m", lifetime: "task" }).includes("agentpier_goal"),
  );
  assert.ok(
    !tools({ id: "a", userAccess: { mode: "shared", members: [] } }).includes(
      "agentpier_goal",
    ),
  );
  assert.ok(!tools({ id: "a", archivedAt: "x" }).includes("agentpier_goal"));
  assert.ok(!profileTools({ id: "a" }, true, false).includes("agentpier_goal"));
  assert.ok(!routineTools.includes("agentpier_goal"));
  assert.ok(lockedTools.includes("agentpier_goal"));
});

test("the bridge serves goal as agentpier_goal, never to a routine run", () => {
  assert.ok(actions.has("goal"));
  assert.equal(bridgeTool("goal"), "agentpier_goal");
  assert.ok(!routineActions.has("goal"));
});

test("the plugin registers agentpier_goal with its schema", () => {
  const tools = [];
  plugin.register({
    pluginConfig: { url: "http://unused", token: "test" },
    registerTool: (factory, options) => tools.push({ factory, options }),
    on() {},
  });
  const entry = tools.find((t) => t.options.name === "agentpier_goal");
  assert.ok(entry);
  const tool = entry.factory.create({
    agentId: "a",
    sessionKey: "s",
    assertInvocationCurrent() {},
  });
  assert.equal(tool.name, "agentpier_goal");
  assert.deepEqual(tool.parameters.properties.action.enum, [
    "set",
    "update",
    "done",
    "blocked",
  ]);
  assert.deepEqual(tool.parameters.required, ["action"]);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.equal(tool.parameters.properties.steps.maxLength, 4000);
});
