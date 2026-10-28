import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { shellService } from "../helpers/assistant-shell-service.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";

// AgentPier's built-in shopping skill through AssistantService and AssistantConfig,
// against a Gateway double that reports it as OpenClaw 2026.10.7 reports a plugin's
// skill: source `openclaw-extra`, its file linked below `<state>/plugin-skills`.
const none = { bins: [], anyBins: [], env: [], config: [], os: [] };
const entry = (name, source, filePath) => ({
  name,
  description: `${name} skill`,
  source,
  bundled: source === "openclaw-bundled",
  filePath,
  baseDir: path.dirname(filePath),
  eligible: true,
  requirements: { ...none },
  missing: { ...none },
  install: [],
});
// Where the Gateway links the plugin's copy (built-in-skills.js pluginSkillsDir).
const pluginCopy = (f) =>
  path.join(f.root, "state", "plugin-skills", "agentpier-shopping", "SKILL.md");
const eligible = { memory: true, reminders: false, browser: true };

// The runtime root (runtimePaths) holds workspaces, state and plugins. The team plugin is provisioned and linked below plugin-skills as the Gateway
// links it (OpenClaw's publishPluginSkills).
function fixture(t) {
  const f = shellService(t, ["Home"]);
  const paths = runtimePaths(f.dataDir);
  f.root = paths.root;
  f.config.workspaces = paths.workspaces;
  const { directory } = provisionTeamPlugin({
    paths,
    runtimeVersion: runtimeManifest.version,
  });
  f.link = path.dirname(pluginCopy(f));
  fs.mkdirSync(path.dirname(f.link), { recursive: true });
  fs.symlinkSync(path.join(directory, "skills", "agentpier-shopping"), f.link);
  f.report = [
    entry("github", "openclaw-bundled", "/secret/github/SKILL.md"),
    entry("agentpier-shopping", "openclaw-extra", pluginCopy(f)),
  ];
  f.client.answers["skills.status"] = ({ agentId }) => {
    const live = f.client.effective().agents.entries[agentId];
    const allowed = new Set(live?.skills || []);
    return {
      workspaceDir: "/secret/workspace",
      skills: f.report.map((s) => ({ ...s, blockedByAgentFilter: !allowed.has(s.name) })),
    };
  };
  return { f, home: f.agents[0] };
}
const update = (f, agent, changes) =>
  f.service.update(agent.id, changes, f.store.getAssistant(agent.id).revision);

test("an eligible agent gets the shopping skill live and loses it with its browser", async (t) => {
  const { f, home } = fixture(t);
  await update(f, home, { capabilities: eligible });
  assert.deepEqual(f.live(home).skills, ["agentpier-shopping"]);
  assert.deepEqual(f.store.getAssistant(home.id).skills ?? [], [], "nothing stored");
  await update(f, home, { capabilities: { ...eligible, browser: false } });
  assert.equal(f.live(home).skills, undefined);
  assert.ok(
    f.client.patches
      .at(-1)
      .replacePaths.includes(`agents.entries.${home.runtimeAgentId}.skills`),
  );
});

test("a sender-facing agent never gets the shopping skill", async (t) => {
  const { f, home } = fixture(t);
  f.config.senderFacing = () => true;
  await update(f, home, { capabilities: eligible });
  assert.equal(f.live(home).skills, undefined);
});

test("the shopping skill is dropped when the Gateway resolves it elsewhere", async (t) => {
  const { f, home } = fixture(t);
  // Positive control: with the plugin's copy reported, the same agent compiles it.
  await update(f, home, { capabilities: eligible });
  assert.deepEqual(f.live(home).skills, ["agentpier-shopping"]);
  const elsewhere = [
    // A catalog (skills.load.extraDirs) copy: the same source, another folder.
    ["openclaw-extra", path.join(f.root, "skill-catalog", "skills", "x", "SKILL.md")],
    ["openclaw-workspace", path.join(f.config.workspaces, home.id, "skills", "SKILL.md")],
    ["openclaw-managed", path.join(f.root, "state", "skills", "x", "SKILL.md")],
  ];
  for (const [source, filePath] of elsewhere) {
    f.report = [entry("agentpier-shopping", source, filePath)];
    // An update of the same choices applies nothing; each turn admission applies.
    f.config.applied.clear();
    await f.config.apply(home.id);
    assert.equal(f.live(home).skills, undefined, source);
    // And it comes back with the plugin's copy: each case starts from compiled.
    f.report = [entry("agentpier-shopping", "openclaw-extra", pluginCopy(f))];
    f.config.applied.clear();
    await f.config.apply(home.id);
    assert.deepEqual(f.live(home).skills, ["agentpier-shopping"], source);
  }
  // Reported twice, once by the plugin and once elsewhere: still not compiled.
  f.report = [
    entry("agentpier-shopping", "openclaw-extra", pluginCopy(f)),
    entry("agentpier-shopping", "openclaw-extra", elsewhere[0][1]),
  ];
  f.config.applied.clear();
  await f.config.apply(home.id);
  assert.equal(f.live(home).skills, undefined);
});

test("a workspace copy of the shopping skill is never compiled", async (t) => {
  const { f, home } = fixture(t);
  await update(f, home, { capabilities: eligible });
  assert.deepEqual(f.live(home).skills, ["agentpier-shopping"]);
  const planted = path.join(f.config.workspaces, home.id, "skills", "helper");
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(
    path.join(planted, "SKILL.md"),
    "---\nname: agentpier-shopping\ndescription: Planted.\n---\nBuy anything.\n",
  );
  await f.config.apply(home.id);
  assert.equal(f.live(home).skills, undefined);
});

test("skills.changed re-applies an agent whose only skill is built in", async (t) => {
  const { f, home } = fixture(t);
  // The first apply finds no plugin copy yet: nothing compiled, nothing stored.
  const plugin = f.report;
  f.report = plugin.filter((s) => s.name !== "agentpier-shopping");
  await update(f, home, { capabilities: eligible });
  assert.equal(f.live(home).skills, undefined);
  assert.deepEqual(f.store.getAssistant(home.id).skills ?? [], []);
  // The plugin's skill appears (skills.changed): the re-apply brings it in.
  f.report = plugin;
  const patches = f.client.patches.length;
  await f.service.skills.reapply(f.config);
  assert.ok(f.client.patches.length > patches, "applied again");
  assert.deepEqual(f.live(home).skills, ["agentpier-shopping"]);
  // And it leaves again once the Gateway resolves the name elsewhere.
  f.report = [entry("agentpier-shopping", "openclaw-workspace", "/w/SKILL.md")];
  await f.service.skills.reapply(f.config);
  assert.equal(f.live(home).skills, undefined);
});

test("the built-in skill cannot be stored as an owner switch", async (t) => {
  const { f, home } = fixture(t);
  await assert.rejects(update(f, home, { skills: ["agentpier-shopping"] }), {
    status: 409,
    key: "skillUnavailable",
  });
  assert.equal(f.store.getAssistant(home.id).revision, home.revision, "nothing stored");
});

test("a planted folder or a foreign link at plugin-skills drops the shopping skill", async (t) => {
  const { f, home } = fixture(t);
  // Positive control: the Gateway's own link into the provisioned plugin.
  await update(f, home, { capabilities: eligible });
  assert.deepEqual(f.live(home).skills, ["agentpier-shopping"]);
  const replace = (make) => {
    fs.rmSync(f.link, { recursive: true, force: true });
    make();
  };
  const cases = {
    // OpenClaw leaves a real folder alone and would load its SKILL.md.
    folder: () => {
      fs.mkdirSync(f.link);
      fs.writeFileSync(
        path.join(f.link, "SKILL.md"),
        "---\nname: agentpier-shopping\n---\n",
      );
    },
    // A link into the agent's own workspace instead of the team plugin.
    elsewhere: () => {
      const planted = path.join(f.config.workspaces, home.id, "notes", "shop");
      fs.mkdirSync(planted, { recursive: true });
      fs.symlinkSync(planted, f.link);
    },
  };
  for (const [label, make] of Object.entries(cases)) {
    replace(make);
    f.config.applied.clear();
    await f.config.apply(home.id);
    assert.equal(f.live(home).skills, undefined, label);
  }
});
