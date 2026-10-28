import test from "node:test";
import { contractTimeout } from "../helpers/contract-timeout.js";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";
import { pluginSkillsDir } from "../../server/features/assistants/built-in-skills.js";
import { teamPluginDirectory } from "../../server/features/assistants/team-plugin-install.js";

// The built-in shopping skill against the pinned OpenClaw: the real team plugin
// declares its `skills` folder, the Gateway links the skill below
// `<state>/plugin-skills/agentpier-shopping/` and reports it as `openclaw-extra`
// (built-in-skills.js). AgentPier compiles it only into an eligible agent's list:
// that agent lists it in its prompt and reads its file; another agent never sees it.
const installed = process.env.AGENTPIER_SKILLS_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SKILLS_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};
const name = "agentpier-shopping";
const shipped = new URL(
  `../../server/features/assistants/team-plugin/skills/${name}/SKILL.md`,
  import.meta.url,
);

// The `<location>` the system prompt lists for the shopping skill, if any.
function skillLocation(input) {
  const text = (input.messages || [])
    .filter((m) => m.role === "system" || m.role === "developer")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
  const block = text.match(
    new RegExp(`<name>${name}</name>[\\s\\S]*?<location>([^<]+)</location>`),
  );
  return block?.[1].trim();
}

// `[cmd:read…]` reads the shopping skill's file at the location the prompt lists.
function readTool(input) {
  if (!JSON.stringify(input.messages).includes("[cmd:read")) return null;
  const location = skillLocation(input);
  return location && { name: "read", arguments: { path: location } };
}

test(
  "an eligible agent lists and reads the shipped shopping skill; others do not",
  options,
  async (t) => {
    const h = await compiledShell(t, installed, {
      prefix: "shopping-skill-",
      tool: readTool,
    });
    const a = h.create("Shopper");
    const b = h.create("Plain");
    // Memory brings the `read` tool; OpenClaw lists skills only to agents that have it.
    // Eligibility reads the browser setting, not whether the browser tool is offered.
    const set = (agent, capabilities) =>
      h.store.updateAssistant(
        agent.id,
        { capabilities: { memory: true, reminders: false, ...capabilities } },
        h.store.getAssistant(agent.id).revision,
      );
    set(a, { browser: true });
    set(b, { browser: false });
    await h.runtime.start();
    await h.config.apply(a.id);
    await h.config.apply(b.id);
    const entries = (await h.running()).agents.entries;
    assert.deepEqual(entries[a.runtimeAgentId].skills, [name]);
    assert.equal(entries[b.runtimeAgentId].skills, undefined);

    // The Gateway reports the plugin's copy by its link below plugin-skills.
    const linkDir = path.join(pluginSkillsDir(h.runtime.paths.root), name);
    assert.equal(
      pluginSkillsDir(h.runtime.paths.root),
      path.join(h.runtime.paths.state, "plugin-skills"),
    );
    const status = async (agent) =>
      (
        await h.runtime.client.call("skills.status", { agentId: agent.runtimeAgentId })
      ).skills.filter((s) => s.name === name);
    const [onA, ...more] = await status(a);
    t.diagnostic(`source=${onA.source} filePath=${onA.filePath}`);
    assert.deepEqual(more, [], "reported once");
    assert.equal(onA.source, "openclaw-extra");
    assert.equal(onA.filePath, path.join(linkDir, "SKILL.md"));
    assert.equal(onA.blockedByAgentFilter, false);
    assert.equal(onA.eligible, true);
    // A link (never a folder) into this version's provisioned team plugin, whose
    // file is the shipped one: what pluginSkillReported requires.
    assert.ok(fs.lstatSync(linkDir).isSymbolicLink());
    const target = fs.realpathSync(linkDir);
    t.diagnostic(`link target=${target}`);
    assert.equal(
      target,
      fs.realpathSync(
        path.join(teamPluginDirectory(h.runtime.paths.root), "skills", name),
      ),
    );
    assert.ok(
      fs.readFileSync(path.join(target, "SKILL.md")).equals(fs.readFileSync(shipped)),
    );
    const [onB] = await status(b);
    assert.equal(onB.blockedByAgentFilter, true);

    // A turn on A lists the skill and reads its file; a turn on B never lists it.
    const turn = async (agent, label) => {
      const from = h.model.requests.length;
      const outcome = await h.settle(await h.send(agent, label, "true"));
      t.diagnostic(`${label} status=${outcome.status} offered=${outcome.offered}`);
      return { ...outcome, prompt: JSON.stringify(h.model.requests.slice(from)) };
    };
    const turnA = await turn(a, "read-a");
    assert.ok(turnA.prompt.includes(`<name>${name}</name>`));
    assert.ok(
      turnA.result?.includes("## Ask once before buying"),
      "the read reached the shipped skill",
    );
    const turnB = await turn(b, "none-b");
    assert.ok(turnB.offered.includes("read"));
    assert.ok(!turnB.prompt.includes(name));
  },
);

test(
  "team members and the switch: the same plugin copy, verified per agent",
  options,
  async (t) => {
    const h = await compiledShell(t, installed, { prefix: "shopping-members-" });
    const lead = h.create("Lead");
    const off = h.create("Switched off");
    const set = (agent, fields) =>
      h.store.updateAssistant(agent.id, fields, h.store.getAssistant(agent.id).revision);
    const eligible = { capabilities: { memory: true, reminders: false, browser: true } };
    set(lead, eligible);
    set(off, { ...eligible, shopping: false });
    // A permanent member with its own browser and memory, and a task member with its
    // lead's browser grant: both in the lead's Gateway and its one state folder.
    const reserve = (id, lifetime) =>
      h.store.reserveMember({
        id,
        parent: lead.id,
        assignment: { name: id },
        snapshot: { instructions: "Run it.", model: h.store.getAssistant(lead.id).model },
        teamId: "team-1",
        lifetime,
      });
    const permanent = reserve("member-permanent", "permanent");
    set(permanent, eligible);
    const task = reserve("member-task", "temporary");
    h.store.memberGrants = () => ({ grants: { browser: true }, shellSsh: false });
    await h.runtime.start();
    for (const agent of [lead, off, permanent, task]) await h.config.apply(agent.id);
    const entries = (await h.running()).agents.entries;
    for (const agent of [lead, permanent, task])
      assert.deepEqual(entries[agent.runtimeAgentId].skills, [name], agent.name);
    assert.equal(entries[off.runtimeAgentId].skills, undefined);
    // Each member reports the plugin's own link, and the verification keeps it.
    const linkDir = path.join(pluginSkillsDir(h.runtime.paths.root), name);
    for (const agent of [permanent, task]) {
      const report = await h.runtime.client.call("skills.status", {
        agentId: agent.runtimeAgentId,
      });
      const entriesOf = report.skills.filter((s) => s.name === name);
      assert.equal(entriesOf.length, 1, agent.name);
      assert.equal(entriesOf[0].source, "openclaw-extra");
      assert.equal(entriesOf[0].filePath, path.join(linkDir, "SKILL.md"));
      assert.equal(entriesOf[0].blockedByAgentFilter, false, agent.name);
      const verified = await h.config.verifySkills(h.store.getAssistant(agent.id), [
        name,
      ]);
      assert.deepEqual(verified, { skills: [name], complete: true }, agent.name);
    }
    // Switching the lead off reaches its task member at the next apply.
    set(lead, { shopping: false });
    h.config.applied.clear();
    for (const agent of [lead, task, permanent]) await h.config.apply(agent.id);
    const after = (await h.running()).agents.entries;
    assert.equal(after[lead.runtimeAgentId].skills, undefined);
    assert.equal(after[task.runtimeAgentId].skills, undefined);
    assert.deepEqual(after[permanent.runtimeAgentId].skills, [name]);
  },
);
