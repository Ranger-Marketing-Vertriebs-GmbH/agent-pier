import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  bundledSkillNames,
  hermesSkills,
  scanSkills,
  skillReport,
} from "../../server/features/assistants/runtimes/hermes/hermes-skills.js";
import { skillEntries } from "../../server/features/assistants/runtimes/hermes/hermes-config/skills.js";
import { connectionOf } from "../../server/features/assistants/runtimes/hermes/hermes-connection.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import { skillCatalog } from "../../server/features/assistants/agent-skills.js";
import { skillLocked } from "../../web/features/assistants/settings/skill-list.js";

const unavailable = (error) => error.code === "UNAVAILABLE" && error.status === 503;

function skill(dir, name, front = "") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} skill\n${front}---\n\n# ${name}\n`,
  );
}

// An installation with three bundled skills, an agent home Hermes seeded two of them
// into (beside one the agent wrote), and a catalog folder.
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const record = { directory: path.join(root, "install") };
  const bundled = path.join(record.directory, "src", "skills");
  skill(
    path.join(bundled, "software-development", "github"),
    "github",
    "prerequisites:\n  commands: [gh-missing-xyz, sh]\n",
  );
  skill(path.join(bundled, "autonomous-ai-agents", "hermes-agent"), "hermes-agent");
  skill(path.join(bundled, "apple", "findmy"), "findmy", "platforms: [windows]\n");
  // Support folders and Hermes's own state are never skills.
  skill(path.join(bundled, "software-development", "github", "references"), "nested");
  skill(path.join(bundled, ".hub", "quarantine"), "quarantined");
  const agent = {
    hermesHome: path.join(root, "home"),
    workspace: path.join(root, "work"),
  };
  const home = path.join(agent.hermesHome, "skills");
  skill(
    path.join(home, "software-development", "github"),
    "github",
    "prerequisites:\n  commands: [gh-missing-xyz, sh]\n",
  );
  skill(path.join(home, "autonomous-ai-agents", "hermes-agent"), "hermes-agent");
  skill(path.join(home, "notes", "my-notes"), "my-notes");
  fs.writeFileSync(
    path.join(home, ".bundled_manifest"),
    "github:abc\nhermes-agent:def\n",
  );
  const catalog = path.join(root, "catalog", "quartz-notes");
  skill(catalog, "quartz-notes");
  fs.writeFileSync(
    path.join(agent.hermesHome, "config.yaml"),
    `skills:\n  disabled: [findmy, hermes-agent]\n  external_dirs: [${catalog}]\n`,
  );
  return { root, record, agent, catalog };
}

test("Hermes skills compile into a deny list of bundled skills and the catalog's folders", () => {
  const agent = desiredAgent({
    id: "a1",
    runtimeAgentId: "ap-a1",
    skills: ["github", "quartz-notes", "weather"],
  });
  const { entries, placed } = skillEntries(agent, {
    bundled: ["findmy", "github", "hermes-agent"],
    catalog: { "quartz-notes": "/c/quartz-notes", other: "/c/other" },
  });
  assert.deepEqual(entries, [
    [["skills", "disabled"], ["findmy"]],
    [["skills", "external_dirs"], ["/c/quartz-notes"]],
  ]);
  assert.deepEqual(placed, ["github", "quartz-notes"]);
  // Without the installation's names the deny list stays as Hermes left it.
  assert.deepEqual(skillEntries(agent, {}).entries, [[["skills", "external_dirs"], []]]);
});

test("the installation's bundled skills are found as Hermes walks its folder", (t) => {
  const { record } = setup(t);
  assert.deepEqual(bundledSkillNames(record), ["findmy", "github", "hermes-agent"]);
  assert.deepEqual(bundledSkillNames({}), []);
  assert.deepEqual(scanSkills(null), []);
});

test("the report names each skill's origin, filter and what it misses", (t) => {
  const { record, agent, catalog } = setup(t);
  const { skills } = skillReport(agent, record, {
    folders: ["/bin"],
    platform: "darwin",
  });
  const byName = Object.fromEntries(skills.map((s) => [s.name, s]));
  assert.deepEqual(
    skills.map((s) => [s.name, s.origin]),
    [
      ["hermes-agent", "bundled"],
      ["my-notes", "local"],
      ["github", "bundled"],
      ["findmy", "bundled"],
      ["quartz-notes", "catalog"],
    ],
  );
  assert.equal(byName.github.blockedByAgentFilter, false);
  assert.deepEqual(byName.github.missing.bins, ["gh-missing-xyz"]);
  assert.equal(byName.github.eligible, false);
  // The essential skill is never filtered, whatever the deny list says.
  assert.equal(byName["hermes-agent"].blockedByAgentFilter, false);
  assert.equal(byName.findmy.blockedByAgentFilter, true);
  assert.equal(byName.findmy.platformIncompatible, true);
  assert.deepEqual(byName.findmy.missing.os, ["windows"]);
  assert.equal(byName["quartz-notes"].filePath, path.join(catalog, "SKILL.md"));
});

test("the skills page lists a Hermes agent's skills by origin", (t) => {
  const { record, agent, root } = setup(t);
  const report = skillReport(agent, record, { folders: ["/bin"], platform: "darwin" });
  const page = skillCatalog({
    report,
    bundled: new Set(
      report.skills.filter((s) => s.origin === "bundled").map((s) => s.name),
    ),
    assistant: { id: "a1", runtimeAgentId: "ap-a1", skills: ["quartz-notes"] },
    catalog: [{ name: "quartz-notes", version: 2 }],
    liveRoot: path.join(root, "catalog"),
  });
  const byName = Object.fromEntries(page.skills.map((s) => [s.name, s]));
  // The catalog's own copy, switched on and offered.
  assert.equal(byName["quartz-notes"].state, "ready");
  assert.equal(byName["quartz-notes"].active, true);
  // A skill the agent wrote itself: on, and not a switch of AgentPier's.
  assert.equal(byName["my-notes"].state, "selfWritten");
  assert.equal(byName["my-notes"].active, true);
  assert.equal(skillLocked(byName["my-notes"], true), true);
  assert.equal(byName.findmy.state, "unsupported");
  assert.equal(byName.github.state, "missing");
});

test("the skills port answers for its own agent only, while the set is ready", async (t) => {
  const { record, agent } = setup(t);
  const supervisor = {
    agentId: "ap-a1",
    client: { ready: true },
    agentPaths: () => agent,
  };
  const skills = hermesSkills(supervisor, { installed: () => record });
  const own = await skills.status({ agentId: "ap-a1" });
  assert.ok(own.skills.some((s) => s.name === "my-notes"));
  const host = await skills.status();
  assert.deepEqual(host.skills.map((s) => s.name).sort(), [
    "findmy",
    "github",
    "hermes-agent",
  ]);
  const refused = await skills.status({ agentId: "nobody" }).catch((error) => error);
  assert.equal(skills.unknownAgent(refused), true);
  assert.equal(skills.unknownAgent(new Error("other")), false);
  const bound = skills.on(connectionOf(supervisor.client));
  supervisor.client.ready = false;
  await assert.rejects(skills.status({ agentId: "ap-a1" }), unavailable);
  supervisor.client = { ready: true };
  await assert.rejects(bound.status(), unavailable);
  // Before any start the installation is unknown: nothing to report.
  const early = hermesSkills(supervisor, { installed: () => null });
  await assert.rejects(early.status({ agentId: "ap-a1" }), unavailable);
});
