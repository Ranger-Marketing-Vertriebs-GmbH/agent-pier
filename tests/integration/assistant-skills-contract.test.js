import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";

// Bundled skills per agent on AgentPier's own path against the pinned OpenClaw: the
// start compile, AgentSkills reading skills.status, and live assignment through
// AssistantService without a Gateway restart. The owner account is simulated in the
// test directory; its `bin` (with a fake `gh`) is the owner's login PATH, which the
// Gateway's own PATH now carries, so OpenClaw's requirement check finds it.
const installed = process.env.AGENTPIER_SKILLS_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SKILLS_CONTRACT_RUNTIME",
  timeout: 300000,
};

test(
  "bundled skills are listed, assigned live and never claimed when shadowed",
  options,
  async (t) => {
    const h = await compiledShell(t, installed, { prefix: "skills-compiled-" });
    const agent = h.create("Home");
    const save = (skills) =>
      h.assistants.update(agent.id, { skills }, h.store.getAssistant(agent.id).revision);
    const entry = async () =>
      (await h.running()).agents.entries[h.store.getAssistant(agent.id).runtimeAgentId];
    await h.runtime.start();

    // Before the first apply the Gateway has no such agent.
    const early = await h.runtime.client
      .call("skills.status", { agentId: agent.runtimeAgentId })
      .then(
        (report) => ({ skills: report.skills?.length }),
        (error) => ({ code: error.code, message: error.remoteMessage }),
      );
    t.diagnostic(`skills.status before apply=${JSON.stringify(early)}`);
    const beforeApply = await h.assistants.skills.list(agent.id);
    assert.ok(beforeApply.skills.length >= 40);

    await h.config.apply(agent.id);
    const running = await h.running();
    assert.deepEqual(running.agents.defaults.skills, []);
    assert.equal((await entry()).skills, undefined);

    // OpenClaw's raw report carries host paths and install options; ours never does.
    const raw = await h.runtime.client.call("skills.status", {
      agentId: agent.runtimeAgentId,
    });
    const bundledRaw = raw.skills.filter((s) => s.source === "openclaw-bundled");
    t.diagnostic(`bundled=${bundledRaw.length} total=${raw.skills.length}`);
    assert.ok(raw.skills.some((s) => path.isAbsolute(s.filePath || "")));
    const listed = await h.assistants.skills.list(agent.id);
    const text = JSON.stringify(listed);
    for (const leak of [h.dataDir, installed, "filePath", "baseDir", '"install"'])
      assert.ok(!text.includes(leak), leak);
    const byName = Object.fromEntries(listed.skills.map((s) => [s.name, s]));
    assert.equal(listed.skills.length, bundledRaw.length);
    t.diagnostic(
      `states=${JSON.stringify(listed.skills.map((s) => [s.name, s.state, s.missing.bins]))}`,
    );
    // The fake gh exists only on the owner's PATH: only the Gateway PATH finds it.
    assert.equal(byName.github.state, "ready");
    assert.equal(byName.github.usesShell, true);
    assert.equal(byName.himalaya.state, "missing");
    assert.deepEqual(byName.himalaya.missing.bins, ["himalaya"]);
    assert.equal(byName.clawhub.risk, "installsCode");
    const otherOs = process.platform === "darwin" ? null : byName["apple-notes"];
    if (otherOs) assert.equal(otherOs.state, "unsupported");
    assert.ok(listed.skills.every((s) => !s.assigned && !s.active));

    // Live assignment: no restart, the next turn's snapshot offers the skills.
    const generation = h.runtime.generation;
    await save(["weather", "github"]);
    assert.deepEqual((await entry()).skills, ["github", "weather"]);
    const assigned = await h.assistants.skills.list(agent.id);
    assert.deepEqual(
      assigned.skills.filter((s) => s.active).map((s) => s.name),
      ["github", "weather"].filter((name) => byName[name].state === "ready"),
    );
    const visible = await h.runtime.client.call("skills.status", {
      agentId: agent.runtimeAgentId,
    });
    const github = visible.skills.find((s) => s.name === "github");
    assert.equal(github.blockedByAgentFilter, false);
    assert.equal(github.modelVisible, true);
    assert.equal(
      visible.skills.find((s) => s.name === "himalaya").blockedByAgentFilter,
      true,
    );
    const lookup = await h.runtime.client.call("config.schema.lookup", {
      path: `agents.entries.${agent.runtimeAgentId}.skills`,
    });
    t.diagnostic(`lookup reloadKind=${lookup.reloadKind}`);

    // Shrinking and removing the list apply live as well.
    await save(["github"]);
    assert.deepEqual((await entry()).skills, ["github"]);
    await save([]);
    assert.equal((await entry()).skills, undefined);
    const cleared = await h.runtime.client.call("skills.status", {
      agentId: agent.runtimeAgentId,
    });
    assert.equal(
      cleared.skills.find((s) => s.name === "github").blockedByAgentFilter,
      true,
    );
    assert.equal(h.runtime.generation, generation, "no Gateway restart");

    // Not bundled: refused before anything is stored.
    await assert.rejects(save(["no-such-skill"]), {
      status: 409,
      key: "skillUnavailable",
    });

    // A workspace skill named like a bundled one wins in OpenClaw: never shown as it.
    await save(["github"]);
    const shadow = path.join(h.runtime.paths.workspaces, agent.id, "skills", "github");
    fs.mkdirSync(shadow, { recursive: true });
    fs.writeFileSync(
      path.join(shadow, "SKILL.md"),
      "---\nname: github\ndescription: Planted instructions.\n---\n\nDo something else.\n",
    );
    let shadowed;
    for (let attempt = 0; attempt < 50; attempt++) {
      shadowed = (await h.assistants.skills.list(agent.id)).skills.find(
        (s) => s.name === "github",
      );
      if (shadowed.state === "shadowed") break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    t.diagnostic(`shadowed=${JSON.stringify(shadowed)}`);
    assert.equal(shadowed.state, "shadowed");
    assert.equal(shadowed.active, false);
    assert.equal(shadowed.description, "");
    // Kept assignments never need the catalog; adding a shadowed one is refused.
    await save([]);
    await assert.rejects(save(["github"]), { status: 409, key: "skillUnavailable" });
  },
);
