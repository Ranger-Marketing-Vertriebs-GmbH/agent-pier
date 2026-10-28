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
import { teamPluginDirectory } from "../../server/features/assistants/team-plugin-install.js";

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

// A runtime root as the Gateway leaves it: the provisioned team plugin, and its link
// below plugin-skills, or a real folder there, or a link to `entry(root)`.
function runtimeRoot(t, entry = "link") {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "built-in-skills-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plugin = teamPluginDirectory(root);
  const shipped = path.join(plugin, "skills", "agentpier-shopping");
  fs.mkdirSync(shipped, { recursive: true });
  fs.writeFileSync(path.join(shipped, "SKILL.md"), "shipped");
  const dir = pluginSkillsDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const link = path.join(dir, "agentpier-shopping");
  if (entry === "link") fs.symlinkSync(shipped, link);
  else if (entry === "folder") fs.mkdirSync(link);
  else {
    const target = entry(root);
    fs.mkdirSync(target, { recursive: true });
    fs.symlinkSync(target, link);
  }
  return { root, dir, shipped };
}
const at = (filePath, source = "openclaw-extra", name = "agentpier-shopping") => ({
  name,
  source,
  filePath,
});

test("pluginSkillReported accepts only the plugin's copy below plugin-skills", (t) => {
  const { root, dir, shipped } = runtimeRoot(t);
  assert.equal(dir, path.join(root, "state", "plugin-skills"));
  const plugin = at(path.join(dir, "agentpier-shopping", "SKILL.md"));
  assert.equal(pluginSkillReported([plugin], root), true);
  assert.equal(pluginSkillReported([], root), false);
  assert.equal(pluginSkillReported([plugin], undefined), false);
  // The Gateway reports the link path; the link's target is no reported copy.
  assert.equal(pluginSkillReported([at(path.join(shipped, "SKILL.md"))], root), false);
  // Another source, a catalog or workspace path, or a sibling folder all fail.
  assert.equal(
    pluginSkillReported([at(plugin.filePath, "openclaw-plugin")], root),
    false,
  );
  assert.equal(
    pluginSkillReported([at(plugin.filePath, "openclaw-workspace")], root),
    false,
  );
  const catalog = at(path.join(root, "skill-catalog", "skills", "agentpier-shopping"));
  assert.equal(pluginSkillReported([plugin, catalog], root), false);
  assert.equal(
    pluginSkillReported([at(path.join(dir, "other", "SKILL.md"))], root),
    false,
  );
  assert.equal(
    pluginSkillReported([at(path.join(dir, "agentpier-shopping", "..", "x"))], root),
    false,
  );
  assert.equal(
    pluginSkillReported([at(plugin.filePath, undefined, "github")], root),
    false,
  );
});

test("a real folder or a foreign link at plugin-skills is never the plugin's copy", (t) => {
  const reported = (root) =>
    pluginSkillReported(
      [at(path.join(pluginSkillsDir(root), "agentpier-shopping", "SKILL.md"))],
      root,
    );
  // OpenClaw leaves a planted folder alone and would load it.
  assert.equal(reported(runtimeRoot(t, "folder").root), false);
  // A link into another folder: an older plugin version, or the agent's workspace.
  for (const target of [
    (root) =>
      path.join(
        root,
        "plugins",
        "teams-0000000000000000",
        "skills",
        "agentpier-shopping",
      ),
    (root) => path.join(root, "workspaces", "a1", "skills", "agentpier-shopping"),
  ])
    assert.equal(reported(runtimeRoot(t, target).root), false, String(target));
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
