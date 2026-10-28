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
  shoppingBlocker,
  shoppingEligible,
  shoppingOn,
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
});

const lead = own({ id: "lead", teamUsage: "suggest" });
const permanent = own({ id: "m1", teamMemberId: "m1", lifetime: "permanent" });
// A task member holds what its lead granted (memberInheritance); its memory is its own.
const task = (inherited = {}) =>
  own({
    id: "m2",
    teamMemberId: "m2",
    lifetime: "temporary",
    capabilities: {},
    inherited: {
      capabilities: { browser: true },
      skills: [],
      shopping: true,
      ...inherited,
    },
  });
// The eligibility matrix: who may get the skill, and why not.
const matrix = [
  ["owner agent", own(), {}, null],
  ["lead", lead, {}, null],
  ["permanent member", permanent, {}, null],
  [
    "permanent member with the lead's shared browser",
    own({
      teamMemberId: "m1",
      lifetime: "permanent",
      capabilities: { memory: true },
      leadCapabilities: { browser: true },
    }),
    {},
    null,
  ],
  ["task member", task(), {}, null],
  ["sender-facing", own(), { senderFacing: true }, null],
  ["user agent", own({ userAccess: { mode: "shared", members: [] } }), {}, "userAgent"],
  [
    "restricted user's own agent",
    own({ userAccess: { mode: "own", members: [{ userId: "u1" }] } }),
    {},
    "userAgent",
  ],
  ["archived", own({ archivedAt: "2026-10-01T00:00:00Z" }), {}, "archived"],
  [
    "archived task member",
    { ...task(), archivedAt: "2026-10-01T00:00:00Z" },
    {},
    "archived",
  ],
  ["no browser", own({ capabilities: { memory: true } }), {}, "browser"],
  ["no memory", own({ capabilities: { browser: true } }), {}, "memory"],
  ["task member without the browser", task({ capabilities: {} }), {}, "browser"],
];

test("the eligibility matrix of the shopping skill", () => {
  for (const [label, assistant, options, blocker] of matrix) {
    assert.equal(shoppingBlocker(assistant), blocker, label);
    assert.equal(shoppingEligible(assistant), blocker === null, label);
    assert.deepEqual(
      builtInSkills(assistant, options),
      blocker === null ? ["agentpier-shopping"] : [],
      label,
    );
  }
});

test("the shopping switch is on by default and off only when stored off", () => {
  assert.equal(shoppingOn(own()), true);
  assert.equal(shoppingOn(own({ shopping: true })), true);
  assert.equal(shoppingOn(own({ shopping: false })), false);
  assert.deepEqual(builtInSkills(own({ shopping: false })), []);
  assert.deepEqual(compiledSkillNames(own({ shopping: false })), ["github"]);
  // Off leaves an eligible agent eligible: the switch, not a missing capability.
  assert.equal(shoppingEligible(own({ shopping: false })), true);
  // A task member follows its lead's switch as well as its own.
  assert.equal(shoppingOn(task()), true);
  assert.equal(shoppingOn(task({ shopping: false })), false);
  assert.equal(shoppingOn({ ...task(), shopping: false }), false);
  assert.deepEqual(builtInSkills(task({ shopping: false })), []);
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
  assert.deepEqual(compiledSkillNames(own({ ...stored, shopping: false })), ["github"]);
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

test("agentEntry compiles the built-in skill for eligible agents with the switch on", () => {
  const ready = { teamsReady: true, nativeReady: true };
  const skillsOf = (assistant, options = {}) =>
    agentEntry({}, assistant, { ...ready, ...options }).skills;
  assert.deepEqual(skillsOf(own()), ["agentpier-shopping", "github"]);
  // An agent with its own Telegram bot gets it too: the skill asks only the owner.
  assert.deepEqual(skillsOf(own(), { senderFacing: true }), [
    "agentpier-shopping",
    "github",
  ]);
  assert.deepEqual(skillsOf(own(), { shadowedSkills: ["agentpier-shopping"] }), [
    "github",
  ]);
  assert.equal(
    agentEntry({}, own(), { teamsReady: true, nativeReady: false }).skills,
    undefined,
  );
  assert.deepEqual(skillsOf(own({ shopping: false })), ["github"]);
  // Team members: permanent and temporary.
  assert.deepEqual(skillsOf(permanent), ["agentpier-shopping", "github"]);
  assert.deepEqual(skillsOf(task({ skills: ["github"] })), [
    "agentpier-shopping",
    "github",
  ]);
});

test("agentEntry compiles no built-in skill for agents of users", () => {
  const ready = { teamsReady: true, nativeReady: true };
  const skillsOf = (assistant) => agentEntry({}, assistant, ready).skills;
  assert.deepEqual(skillsOf(own({ userAccess: { mode: "shared", members: [] } })), [
    "github",
  ]);
  assert.deepEqual(
    skillsOf(own({ userAccess: { mode: "own", members: [{ userId: "u1" }] } })),
    ["github"],
  );
});
