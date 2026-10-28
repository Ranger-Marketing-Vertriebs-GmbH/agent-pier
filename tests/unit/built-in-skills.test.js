import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  builtInSkillNames,
  builtInSkills,
  compiledSkillNames,
  pluginSkillReported,
  pluginSkillsDir,
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

test("a stored built-in name is ignored; an eligible agent gets the built-in once", () => {
  assert.deepEqual(
    compiledSkillNames(own({ skills: ["agentpier-shopping", "github"] })),
    ["agentpier-shopping", "github"],
  );
});

test("an ineligible agent never compiles a stored built-in name", () => {
  const stored = { skills: ["agentpier-shopping", "github"] };
  assert.deepEqual(
    compiledSkillNames(own({ ...stored, capabilities: { memory: true } })),
    ["github"],
  );
  assert.deepEqual(compiledSkillNames(own({ ...stored, archivedAt: "2026-10-01" })), []);
  assert.deepEqual(
    compiledSkillNames(own({ skills: ["agentpier-shopping"] }), { senderFacing: true }),
    [],
  );
});

test("pluginSkillReported accepts only the plugin's copy below plugin-skills", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "built-in-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = pluginSkillsDir(root);
  assert.equal(dir, path.join(root, "state", "plugin-skills"));
  // As the Gateway publishes it: a link into the plugin's own skill folder.
  const pluginFolder = path.join(
    root,
    "plugins",
    "teams-x",
    "skills",
    "agentpier-shopping",
  );
  fs.mkdirSync(pluginFolder, { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(pluginFolder, path.join(dir, "agentpier-shopping"));
  const at = (filePath, source = "openclaw-extra", name = "agentpier-shopping") => ({
    name,
    source,
    filePath,
  });
  const plugin = at(path.join(dir, "agentpier-shopping", "SKILL.md"));
  assert.equal(pluginSkillReported([plugin], dir), true);
  // The realpath of the folder counts as well (macOS /var -> /private/var).
  const real = path.join(fs.realpathSync(dir), "agentpier-shopping", "SKILL.md");
  assert.equal(pluginSkillReported([at(real)], dir), true);
  // The link itself is never followed: its target is not the reported link path.
  assert.equal(
    pluginSkillReported([at(path.join(pluginFolder, "SKILL.md"))], dir),
    false,
  );
  assert.equal(pluginSkillReported([], dir), false);
  assert.equal(pluginSkillReported([plugin], undefined), false);
  // Another source, a catalog or workspace path, or a sibling folder all fail.
  assert.equal(pluginSkillReported([at(plugin.filePath, "openclaw-plugin")], dir), false);
  assert.equal(
    pluginSkillReported([at(plugin.filePath, "openclaw-workspace")], dir),
    false,
  );
  const catalog = at(path.join(root, "skill-catalog", "skills", "agentpier-shopping"));
  assert.equal(pluginSkillReported([plugin, catalog], dir), false);
  assert.equal(
    pluginSkillReported([at(path.join(dir, "other", "SKILL.md"))], dir),
    false,
  );
  assert.equal(
    pluginSkillReported([at(path.join(dir, "agentpier-shopping", "..", "x"))], dir),
    false,
  );
  assert.equal(
    pluginSkillReported([at(plugin.filePath, undefined, "github")], dir),
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

test("agentEntry compiles no built-in skill for agents serving others", () => {
  const ready = { teamsReady: true, nativeReady: true };
  const skillsOf = (assistant) => agentEntry({}, assistant, ready).skills;
  // An agent for users, shared or a restricted user's own.
  assert.deepEqual(skillsOf(own({ userAccess: { mode: "shared", members: [] } })), [
    "github",
  ]);
  assert.deepEqual(
    skillsOf(own({ userAccess: { mode: "own", members: [{ userId: "u1" }] } })),
    ["github"],
  );
  // Team members: permanent, temporary, and a permanent one whose lead shares
  // browser and memory with it.
  assert.deepEqual(skillsOf(own({ teamMemberId: "t1", lifetime: "permanent" })), [
    "github",
  ]);
  const temporary = own({
    teamMemberId: "t1",
    lifetime: "temporary",
    inherited: { capabilities: { memory: true, browser: true }, skills: ["github"] },
  });
  assert.deepEqual(skillsOf(temporary), ["github"]);
  const shared = own({
    teamMemberId: "t1",
    lifetime: "permanent",
    capabilities: {},
    leadCapabilities: { browser: true, memory: true },
  });
  assert.deepEqual(skillsOf(shared), ["github"]);
});
