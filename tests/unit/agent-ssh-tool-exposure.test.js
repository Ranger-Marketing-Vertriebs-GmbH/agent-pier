import test from "node:test";
import assert from "node:assert/strict";
import {
  profileTools,
  routineTools,
} from "../../server/features/assistants/native-capabilities.js";
import { nativeTools } from "../../server/features/assistants/runtime-config.js";
import { agentEntry } from "../../server/features/assistants/openclaw-config/agent-entry.js";

const agent = { id: "a", capabilities: {}, shell: "off" };

test("agentpier_ssh is offered only to eligible agents with a grant", () => {
  assert.ok(
    profileTools(agent, true, true, true, {}, [], true).includes("agentpier_ssh"),
  );
  assert.ok(
    !profileTools(agent, true, true, true, {}, [], false).includes("agentpier_ssh"),
  );
  assert.ok(
    !profileTools(agent, true, false, true, {}, [], true).includes("agentpier_ssh"),
  );
  const task = { ...agent, teamMemberId: "m", lifetime: "task" };
  assert.ok(
    !profileTools(task, true, true, true, {}, [], true).includes("agentpier_ssh"),
  );
  const permanent = { ...agent, teamMemberId: "m", lifetime: "permanent" };
  assert.ok(
    profileTools(permanent, true, true, true, {}, [], true).includes("agentpier_ssh"),
  );
  const archived = { ...agent, archivedAt: "2026-10-16" };
  assert.ok(
    !profileTools(archived, true, true, true, {}, [], true).includes("agentpier_ssh"),
  );
});

test("the routine cap and the Gateway's upper bound include agentpier_ssh", () => {
  assert.ok(routineTools.includes("agentpier_ssh"));
  assert.ok(nativeTools.includes("agentpier_ssh"));
});

test("a compiled agent entry carries the tool only with ssh", () => {
  const options = { teamsReady: true, nativeReady: true, guardProven: false };
  assert.ok(
    agentEntry({}, agent, { ...options, ssh: true }).tools.allow.includes(
      "agentpier_ssh",
    ),
  );
  assert.ok(!agentEntry({}, agent, options).tools.allow.includes("agentpier_ssh"));
});
