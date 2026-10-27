import test from "node:test";
import assert from "node:assert/strict";
import {
  catalogSource,
  skillCatalog,
} from "../../server/features/assistants/agent-skills.js";
import { catalogView } from "../../server/http/routes/agent-skill-catalog.js";

// Catalog skills (skills.load.extraDirs) on an agent's skill page, next to the
// bundled ones; skills.status entries in the shape of tests/unit/agent-skills.test.js.
const none = { bins: [], anyBins: [], env: [], config: [], os: [] };
const host = "/Users/owner/Library/AgentPier/assistants";
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
  primaryEnv: undefined,
  requirements: { ...none },
  missing: { ...none },
  configChecks: [],
  install: [],
  ...extra,
});
const agent = (extra = {}) => ({ id: "a", runtimeAgentId: "ap-a", ...extra });
const live = `${host}/skill-catalog/skills`;
const extra = (name, more = {}) =>
  status(name, {
    source: catalogSource,
    bundled: false,
    filePath: `${live}/${name}/SKILL.md`,
    baseDir: `${live}/${name}`,
    ...more,
  });
const states = (skills) => Object.fromEntries(skills.map((s) => [s.name, s.state]));

test("a catalog skill is listed next to bundled ones without paths", () => {
  const { skills } = skillCatalog({
    report: {
      skills: [status("github"), extra("probe", { blockedByAgentFilter: false })],
    },
    bundled: new Set(["github"]),
    assistant: agent({ skills: ["probe"] }),
    roots: [host],
    catalog: [{ name: "probe", version: 2 }],
    liveRoot: live,
  });
  assert.equal(catalogSource, "openclaw-extra");
  const probe = skills.find((s) => s.name === "probe");
  assert.equal(probe.source, "catalog");
  assert.equal(probe.version, 2);
  assert.equal(probe.state, "ready");
  assert.equal(probe.assigned, true);
  assert.equal(probe.active, true);
  assert.equal(skills.find((s) => s.name === "github").source, undefined);
  assert.ok(!JSON.stringify(skills).includes(host));
});

test("a catalog name the runtime bundles is shadowed", () => {
  const { skills } = skillCatalog({
    report: { skills: [status("github"), extra("github")] },
    bundled: new Set(["github"]),
    assistant: agent(),
    roots: [host],
    catalog: [{ name: "github", version: 1 }],
    liveRoot: live,
  });
  // One row per name: the catalog's, shadowed.
  assert.equal(skills.length, 1);
  assert.equal(skills[0].source, "catalog");
  assert.equal(skills[0].state, "shadowed");
  assert.equal(skills[0].shadowedBy, "bundled");
});

test("a non-catalog skill of a catalog name, or one outside the root, is shadowed", () => {
  const { skills } = skillCatalog({
    report: {
      skills: [
        status("mine", { source: "openclaw-workspace", bundled: false }),
        extra("elsewhere", {
          filePath: `${host}/other/elsewhere/SKILL.md`,
          baseDir: `${host}/other/elsewhere`,
        }),
        extra("sneaky", { filePath: `${live}/../sneaky/SKILL.md` }),
        extra("planted"),
      ],
    },
    assistant: agent({ skills: ["mine"] }),
    roots: [host],
    shadowed: new Set(["planted"]),
    catalog: ["mine", "elsewhere", "sneaky", "planted"].map((name) => ({
      name,
      version: 1,
    })),
    liveRoot: live,
  });
  assert.deepEqual(states(skills), {
    elsewhere: "shadowed",
    mine: "shadowed",
    planted: "shadowed",
    sneaky: "shadowed",
  });
  for (const skill of skills) assert.equal(skill.source, "catalog");
  // Why each is shadowed: another source, or a skill in this agent's own folders.
  assert.deepEqual(Object.fromEntries(skills.map((s) => [s.name, s.shadowedBy])), {
    elsewhere: "source",
    mine: "source",
    planted: "agentFolder",
    sneaky: "source",
  });
  assert.equal(skills.find((s) => s.name === "mine").description, "");
  assert.equal(skills.find((s) => s.name === "mine").active, false);
});

test("needsSettings from the record or the report's env, config or primaryEnv", () => {
  const { skills } = skillCatalog({
    report: {
      skills: [
        extra("record"),
        extra("env", { requirements: { ...none, env: ["TOKEN"] } }),
        extra("config", { requirements: { ...none, config: ["x.y"] } }),
        extra("primary", { primaryEnv: "API_KEY" }),
        extra("plain", { blockedByAgentFilter: false }),
      ],
    },
    assistant: agent({ skills: ["env", "plain"] }),
    roots: [host],
    catalog: [
      { name: "record", version: 1, needsSettings: true },
      ...["env", "config", "primary", "plain"].map((name) => ({ name, version: 1 })),
    ],
    liveRoot: live,
  });
  assert.deepEqual(states(skills), {
    config: "needsSettings",
    env: "needsSettings",
    plain: "ready",
    primary: "needsSettings",
    record: "needsSettings",
  });
  assert.equal(skills.find((s) => s.name === "env").active, false);
});

test("a damaged record is damaged; a missing report entry is unavailable", () => {
  const { skills } = skillCatalog({
    report: { skills: [extra("broken")] },
    assistant: agent({ skills: ["broken"] }),
    roots: [host],
    catalog: [
      { name: "broken", version: 3, damaged: true },
      { name: "absent", version: 1, description: `In ${host}/x` },
    ],
    liveRoot: live,
  });
  assert.deepEqual(states(skills), { absent: "unavailable", broken: "damaged" });
  const absent = skills.find((s) => s.name === "absent");
  assert.equal(absent.source, "catalog");
  assert.equal(absent.version, 1);
  assert.ok(!JSON.stringify(skills).includes(host));
});

test("the fallback report keeps catalog entries", () => {
  const { skills } = skillCatalog({
    report: {
      skills: [
        status("github"),
        extra("probe", { blockedByAgentFilter: false }),
        status("mine", { source: "openclaw-workspace", bundled: false }),
      ],
    },
    bundled: new Set(["github"]),
    assistant: agent({ skills: ["probe"] }),
    roots: [host],
    fallback: true,
    catalog: [{ name: "probe", version: 1 }],
    liveRoot: live,
  });
  assert.deepEqual(states(skills), { github: "ready", probe: "ready" });
  // Read for another agent: never confirmed active for this one.
  assert.equal(skills.find((s) => s.name === "probe").active, false);
});

test("the catalog page shows the programs a skill needs and names clashes", () => {
  const record = (name, more = {}) => ({ id: `id-${name}`, name, version: 1, ...more });
  const entries = [
    extra("probe", {
      requirements: { ...none, bins: ["gh", 1], anyBins: ["a"], env: ["X"] },
    }),
    extra("github"),
    status("github"),
    status("mine", { source: "openclaw-workspace" }),
    extra("mine"),
  ];
  const view = (r, agents) =>
    catalogView(r, { entries, bundled: new Set(["github"]), agents });
  const probe = view(record("probe"), [{ id: "a", name: "A" }]);
  assert.deepEqual(probe.requirements, { bins: ["gh"], anyBins: ["a"] });
  assert.deepEqual(probe.agents, [{ id: "a", name: "A" }]);
  assert.equal(probe.state, "ready");
  assert.ok(!JSON.stringify(probe).includes(host));
  assert.equal(view(record("github")).state, "shadowed");
  assert.equal(view(record("github")).shadowedBy, "bundled");
  assert.equal(view(record("mine")).state, "shadowed");
  assert.equal(view(record("mine")).shadowedBy, "source");
  assert.equal(view(record("probe")).shadowedBy, undefined);
  // Like the agent page: not reported by a running Gateway, or its last check failed.
  assert.equal(view(record("absent")).state, "unavailable");
  assert.equal(
    catalogView(record("probe"), { entries, failed: new Set(["probe"]) }).state,
    "unavailable",
  );
  assert.equal(view(record("mine", { damaged: true })).state, "damaged");
  assert.equal(view(record("envy", { needsSettings: true })).state, "needsSettings");
  // Without a running Gateway: no requirements, no agents given.
  const bare = catalogView(record("probe"));
  assert.equal(bare.requirements, undefined);
  assert.deepEqual(bare.agents, []);
});
