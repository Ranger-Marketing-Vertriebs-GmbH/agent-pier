import test from "node:test";
import assert from "node:assert/strict";
import {
  builtInSkillNames,
  builtInSkills,
  compiledSkillNames,
  pluginSkillReported,
  shoppingEligible,
  shoppingSkill,
} from "../../server/features/assistants/built-in-skills.js";
import { agentEntry } from "../../server/features/assistants/openclaw-config/agent-entry.js";

const own = (extra = {}) => ({
  id: "a1",
  runtimeAgentId: "ap-a1",
  capabilities: { memory: true, browser: true },
  skills: ["github"],
  ...extra,
});

test("the built-in names hold only the shopping skill", () => {
  assert.equal(shoppingSkill, "agentpier-shopping");
  assert.deepEqual(builtInSkillNames, ["agentpier-shopping"]);
  assert.deepEqual(builtInSkills(own()), ["agentpier-shopping"]);
  assert.deepEqual(builtInSkills(own(), { senderFacing: true }), []);
});

test("the owner's own agent with browser and memory gets the shopping skill", () => {
  assert.equal(shoppingEligible(own()), true);
  assert.deepEqual(compiledSkillNames(own()), ["agentpier-shopping", "github"]);
});

test("no shopping skill without browser, without memory, archived or sender-facing", () => {
  assert.equal(
    shoppingEligible(own({ capabilities: { memory: true, browser: false } })),
    false,
  );
  assert.equal(
    shoppingEligible(own({ capabilities: { memory: false, browser: true } })),
    false,
  );
  assert.equal(shoppingEligible(own({ archivedAt: "2026-10-01T00:00:00Z" })), false);
  assert.equal(shoppingEligible(own(), { senderFacing: true }), false);
  assert.deepEqual(compiledSkillNames(own(), { senderFacing: true }), ["github"]);
});

test("agents of users and team members never get the shopping skill", () => {
  assert.equal(
    shoppingEligible(own({ userAccess: { mode: "shared", users: [] } })),
    false,
  );
  assert.equal(
    shoppingEligible(own({ teamMemberId: "t1", lifetime: "permanent" })),
    false,
  );
  const temporary = own({
    teamMemberId: "t1",
    lifetime: "temporary",
    inherited: { capabilities: { memory: true, browser: true }, skills: [] },
  });
  assert.equal(shoppingEligible(temporary), false);
});

test("the compiled list stays unique when the owner also names a built-in skill", () => {
  assert.deepEqual(
    compiledSkillNames(own({ skills: ["agentpier-shopping", "github"] })),
    ["agentpier-shopping", "github"],
  );
});

test("pluginSkillReported accepts only the plugin's copy", () => {
  assert.equal(pluginSkillReported([{ source: "openclaw-plugin" }]), true);
  assert.equal(pluginSkillReported([]), false);
  assert.equal(
    pluginSkillReported([{ source: "openclaw-plugin" }, { source: "openclaw-extra" }]),
    false,
  );
});

test("agentEntry compiles the built-in skill only for eligible agents", () => {
  const ready = { teamsReady: true, nativeReady: true };
  assert.deepEqual(agentEntry({}, own(), ready).skills, ["agentpier-shopping", "github"]);
  assert.deepEqual(agentEntry({}, own(), { ...ready, senderFacing: true }).skills, [
    "github",
  ]);
  assert.deepEqual(
    agentEntry({}, own(), { ...ready, shadowedSkills: ["agentpier-shopping"] }).skills,
    ["github"],
  );
  assert.equal(
    agentEntry({}, own(), { teamsReady: true, nativeReady: false }).skills,
    undefined,
  );
});
