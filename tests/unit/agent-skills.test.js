import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bundledSkillNames,
  sanitizeSkill,
  skillCatalog,
  skillRisks,
  withoutHostPaths,
} from "../../server/features/assistants/agent-skills.js";
import {
  validateDefinition,
  validateSkills,
} from "../../server/features/assistants/assistant-validation.js";
import { personalSkills } from "../../server/features/assistants/native-capabilities.js";
import { agentEntry } from "../../server/features/assistants/openclaw-config/agent-entry.js";
import { compileOpenClawConfig } from "../../server/features/assistants/runtime-config.js";
import {
  anyName,
  frontmatterName,
  shadowedSkills,
  shadowingSkillNames,
  skillShadowRoots,
} from "../../server/features/assistants/openclaw-config/skill-shadows.js";

const none = { bins: [], anyBins: [], env: [], config: [], os: [] };
const host = "/Users/owner/Library/AgentPier/assistants";
// One skills.status entry as OpenClaw 2026.9.9 reports it (dist/status-*.mjs).
const status = (name, extra = {}) => ({
  name,
  description: `${name} skill`,
  source: "openclaw-bundled",
  bundled: true,
  filePath: `${host}/runtimes/x/app/node_modules/openclaw/skills/${name}/SKILL.md`,
  baseDir: `${host}/runtimes/x/app/node_modules/openclaw/skills/${name}`,
  skillKey: name,
  always: false,
  disabled: false,
  blockedByAllowlist: false,
  blockedByAgentFilter: true,
  eligible: true,
  platformIncompatible: false,
  emoji: "🐙",
  homepage: "https://example.com/skill",
  primaryEnv: undefined,
  requirements: { ...none },
  missing: { ...none },
  configChecks: [{ path: "skills.entries.x", satisfied: true }],
  install: [{ id: "brew", kind: "brew", label: "Install gh (brew)", bins: ["gh"] }],
  ...extra,
});
const agent = (extra = {}) => ({ id: "a", runtimeAgentId: "ap-a", ...extra });

test("skill lists are validated, sorted and deduplicated", () => {
  assert.deepEqual(validateSkills(["weather", "github", "weather"]), [
    "github",
    "weather",
  ]);
  assert.deepEqual(validateSkills([]), []);
  for (const bad of [
    "github",
    [1],
    ["GitHub"],
    ["../x"],
    ["-x"],
    ["a".repeat(65)],
    Array.from({ length: 65 }, (_, i) => `s${i}`),
  ])
    assert.throws(() => validateSkills(bad), { status: 400 });
  assert.deepEqual(validateDefinition({ skills: ["tmux"] }, true), { skills: ["tmux"] });
});

test("only eligible agents compile skills", () => {
  assert.deepEqual(personalSkills(agent({ skills: ["tmux", "github", "tmux"] })), [
    "github",
    "tmux",
  ]);
  assert.deepEqual(personalSkills(agent()), []);
  assert.deepEqual(
    personalSkills(agent({ skills: ["tmux"], teamMemberId: "m", lifetime: "temporary" })),
    [],
  );
  assert.deepEqual(personalSkills(agent({ skills: ["tmux"], archivedAt: "x" })), []);
  assert.deepEqual(
    personalSkills(agent({ skills: ["tmux"], teamMemberId: "m", lifetime: "permanent" })),
    ["tmux"],
  );
});

test("the browser never sees host paths, install options or config checks", () => {
  const skill = sanitizeSkill(
    status("github", {
      description: `Uses ${host}/state/gh.json`,
      requirements: { ...none, bins: ["gh"] },
      missing: { ...none, bins: ["gh"], config: [`${host}/x`] },
      homepage: "javascript:alert(1)",
    }),
    [host],
  );
  assert.deepEqual(skill, {
    name: "github",
    description: "Uses …/state/gh.json",
    emoji: "🐙",
    state: "missing",
    missing: { ...none, bins: ["gh"], config: ["…/x"] },
    usesShell: true,
  });
  const text = JSON.stringify(skill);
  for (const leak of ["filePath", "baseDir", "install", "configChecks", host, "brew"])
    assert.ok(!text.includes(leak), leak);
  assert.equal(withoutHostPaths("a /b c", ["/", "", "relative"]), "a /b c");
});

test("states: ready, missing, unsupported, disabled", () => {
  const state = (extra) => sanitizeSkill(status("x", extra)).state;
  assert.equal(state({}), "ready");
  assert.equal(state({ eligible: false, missing: { ...none, env: ["KEY"] } }), "missing");
  assert.equal(state({ missing: { ...none, anyBins: ["a", "b"] } }), "missing");
  assert.equal(
    state({ platformIncompatible: true, missing: { ...none, os: ["darwin"] } }),
    "unsupported",
  );
  assert.equal(state({ disabled: true, eligible: false }), "disabled");
  assert.equal(sanitizeSkill(status("x")).usesShell, false);
  assert.equal(
    sanitizeSkill(status("x", { requirements: { ...none, anyBins: ["a"] } })).usesShell,
    true,
  );
});

test("the catalog lists bundled skills, marks shadowed ones and never others", () => {
  const report = {
    workspaceDir: `${host}/workspaces/a`,
    skills: [
      status("github", { blockedByAgentFilter: false }),
      status("weather"),
      status("clawhub"),
      // A workspace skill named like a bundled one wins in OpenClaw.
      status("tmux", { source: "openclaw-workspace", bundled: false }),
      // Workspace, managed and custodian skills are never offered.
      status("my-notes", { source: "openclaw-workspace", bundled: false }),
      status("custodian", { source: "openclaw-custodian", bundled: true }),
    ],
  };
  const { skills, assigned, shell } = skillCatalog({
    report,
    bundled: new Set(["github", "weather", "clawhub", "tmux", "gone"]),
    assistant: agent({ skills: ["github", "tmux", "removed"], shell: "approval" }),
    roots: [host],
  });
  assert.deepEqual(assigned, ["github", "removed", "tmux"]);
  assert.equal(shell, "approval");
  assert.deepEqual(
    skills.map((s) => [s.name, s.state, s.assigned, s.active]),
    [
      ["clawhub", "ready", false, false],
      ["github", "ready", true, true],
      ["gone", "unavailable", false, false],
      ["removed", "unavailable", true, false],
      ["tmux", "shadowed", true, false],
      ["weather", "ready", false, false],
    ],
  );
  // The shadowing skill's own text is not shown as the bundled one's.
  assert.equal(skills.find((s) => s.name === "tmux").description, "");
  assert.equal(skills.find((s) => s.name === "clawhub").risk, "installsCode");
  assert.equal(skills.find((s) => s.name === "github").risk, undefined);
  assert.ok(!JSON.stringify(skills).includes(host));
  // Every owner-named risky skill carries a warning.
  for (const name of [
    "clawhub",
    "control-ui",
    "node-connect",
    "skill-creator",
    "coding-agent",
    "healthcheck",
    "visualize",
  ])
    assert.ok(skillRisks[name], name);
});

test("bundled names come from the runtime package's skills folder", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entry = path.join(root, "openclaw.mjs");
  for (const name of ["github", "weather", "Bad Name", "no-skill-file"])
    fs.mkdirSync(path.join(root, "skills", name), { recursive: true });
  for (const name of ["github", "weather", "Bad Name"])
    fs.writeFileSync(path.join(root, "skills", name, "SKILL.md"), "---\n---\n");
  fs.writeFileSync(path.join(root, "skills", "pyproject.toml"), "");
  assert.deepEqual([...bundledSkillNames(entry)].sort(), ["github", "weather"]);
  assert.deepEqual([...bundledSkillNames(path.join(root, "missing", "x.mjs"))], []);
  assert.deepEqual([...bundledSkillNames(undefined)], []);
});

test("agent entries carry the skill list only with native tools ready", () => {
  const assistant = agent({ skills: ["tmux", "github"], capabilities: {} });
  const ready = { teamsReady: true, nativeReady: true };
  assert.deepEqual(agentEntry({}, assistant, ready).skills, ["github", "tmux"]);
  assert.equal(agentEntry({ skills: ["x"] }, agent(), ready).skills, undefined);
  assert.equal(
    agentEntry({ skills: ["x"] }, assistant, { teamsReady: true, nativeReady: false })
      .skills,
    undefined,
  );
  // Unmanaged tools leave a foreign entry's list alone.
  assert.deepEqual(
    agentEntry({ skills: ["x"] }, assistant, { toolsManaged: false }).skills,
    ["x"],
  );
});

test("the start compile writes each eligible agent's list over defaults of none", () => {
  const profiles = [
    agent({ skills: ["github"] }),
    { id: "b", runtimeAgentId: "ap-b", skills: ["tmux"], archivedAt: "x" },
    { id: "c", runtimeAgentId: "ap-c" },
  ];
  const config = compileOpenClawConfig({
    existing: {
      agents: {
        entries: {
          "ap-a": { id: "ap-a" },
          "ap-b": { id: "ap-b", skills: ["tmux"] },
          "ap-c": { id: "ap-c", skills: ["weather"] },
          foreign: { id: "foreign", skills: ["weather"] },
        },
      },
    },
    paths: { workspaces: "/w", logs: "/l" },
    port: 1,
    token: "t",
    teams: {
      directory: "/plugin",
      connection: { url: "http://127.0.0.1:1", token: "b" },
      hostMaxConcurrent: 2,
      native: { token: "h" },
      profiles,
    },
  });
  assert.deepEqual(config.agents.defaults.skills, []);
  const { entries } = config.agents;
  assert.deepEqual(entries["ap-a"].skills, ["github"]);
  for (const id of ["ap-b", "ap-c", "foreign"])
    assert.equal(entries[id].skills, undefined);
});

test("every compile scans only the catalog root", () => {
  const paths = {
    workspaces: "/d/assistants/workspaces",
    logs: "/d/l",
    catalogSkills: "/d/assistants/skill-catalog/skills",
  };
  const config = compileOpenClawConfig({
    existing: { skills: { load: { extraDirs: ["/x"] } } },
    paths,
    port: 1,
    token: "t",
    teams: null,
  });
  assert.deepEqual(config.skills.load, { extraDirs: [paths.catalogSkills], watch: true });
});

test("skill folders that would replace a bundled skill are found by any name", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-shadows-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plant = (dir, text = "---\n---\n") => {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
    fs.writeFileSync(path.join(root, dir, "SKILL.md"), text);
  };
  plant("workspaces/a/skills/tmux");
  plant("workspaces/a/skills/group/inner", "---\nname: 'github'\n---\n");
  plant("workspaces/a/.agents/skills/x", '---\ndescription: d\nname: "weather"\n---\n');
  plant("state/skills/notion");
  plant("workspaces/other/skills/spike");
  const roots = skillShadowRoots(root, "a");
  assert.deepEqual([...shadowingSkillNames(roots)].sort(), [
    "github",
    "inner",
    "notion",
    "tmux",
    "weather",
    "x",
  ]);
  assert.deepEqual(shadowedSkills(root, { id: "a" }, ["github", "spike", "summarize"]), [
    "github",
  ]);
  assert.deepEqual(shadowedSkills(root, { id: "a" }, []), []);
});

test("shadowed names are neither compiled nor shown as active", () => {
  const assistant = agent({ skills: ["github", "tmux"], capabilities: {} });
  const ready = { teamsReady: true, nativeReady: true };
  assert.deepEqual(
    agentEntry({}, assistant, { ...ready, shadowedSkills: ["github"] }).skills,
    ["tmux"],
  );
  assert.equal(
    agentEntry({}, assistant, { ...ready, shadowedSkills: ["github", "tmux"] }).skills,
    undefined,
  );
  const config = compileOpenClawConfig({
    existing: { agents: { entries: { "ap-a": { id: "ap-a" } } } },
    paths: { workspaces: "/w", logs: "/l" },
    port: 1,
    token: "t",
    teams: {
      directory: "/plugin",
      connection: { url: "http://127.0.0.1:1", token: "b" },
      hostMaxConcurrent: 2,
      native: { token: "h" },
      profiles: [assistant],
    },
    skillShadows: { "ap-a": ["tmux"] },
  });
  assert.deepEqual(config.agents.entries["ap-a"].skills, ["github"]);
  const { skills } = skillCatalog({
    report: { skills: [status("github", { blockedByAgentFilter: false })] },
    assistant,
    shadowed: new Set(["github"]),
  });
  assert.deepEqual(
    skills.map((s) => [s.name, s.state, s.assigned, s.active]),
    [
      ["github", "shadowed", true, false],
      ["tmux", "unavailable", true, false],
    ],
  );
});

test("a fallback report for another agent never decides this agent's state", () => {
  const { skills } = skillCatalog({
    report: {
      skills: [
        status("github", { blockedByAgentFilter: false }),
        status("tmux", { source: "openclaw-workspace" }),
      ],
    },
    bundled: new Set(["github", "tmux"]),
    assistant: agent({ skills: ["github"] }),
    fallback: true,
  });
  assert.deepEqual(
    skills.map((s) => [s.name, s.state, s.active]),
    [
      ["github", "ready", false],
      ["tmux", "unavailable", false],
    ],
  );
});

test("host paths are cut only at whole segments; prototype names are no risk", () => {
  assert.equal(
    withoutHostPaths("/Users/d/x /Users/dave/y /Users/d. /Users/d", ["/Users/d/"]),
    "…/x /Users/dave/y /Users/d. …",
  );
  const { skills } = skillCatalog({
    report: { skills: [status("constructor")] },
    assistant: agent(),
  });
  assert.equal("risk" in skills[0], false);
});

test("frontmatter names are read as YAML, and doubtful files shadow every name", (t) => {
  const fm = (block) => frontmatterName(`---\n${block}\n---\nBody.\n`);
  assert.equal(fm("name: github # note"), "github");
  assert.equal(fm("name: >-\n  github\ndescription: d"), "github");
  assert.equal(fm('"name": github'), "github");
  assert.equal(fm("name : github"), "github");
  assert.equal(fm("name: '  GitHub '"), "GitHub");
  assert.equal(fm("description: only"), undefined);
  assert.equal(frontmatterName("No frontmatter at all."), undefined);
  assert.equal(frontmatterName("---\n---\n"), undefined);
  for (const doubtful of ["name: [github", "name: 42", "name:", "- name: github"])
    assert.equal(fm(doubtful), anyName, doubtful);
  // Cut off before the closing delimiter: it could hold any name.
  assert.equal(frontmatterName("---\nname: a\n", true), anyName);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "skill-yaml-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const plant = (dir, text) => {
    const folder = path.join(root, "workspaces", "a", "skills", dir);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "SKILL.md"), text);
  };
  plant("helper", "---\nname: github # planted\n---\nDo something else.\n");
  assert.deepEqual(shadowedSkills(root, { id: "a" }, ["github", "weather"]), ["github"]);
  // Compared without case as well, which only drops more.
  plant("other", "---\nname: Weather\n---\n");
  assert.deepEqual(shadowedSkills(root, { id: "a" }, ["github", "weather"]), [
    "github",
    "weather",
  ]);
  plant("broken", "---\nname: [weather\n---\n");
  assert.deepEqual(shadowedSkills(root, { id: "a" }, ["tmux", "weather"]), [
    "tmux",
    "weather",
  ]);
});
