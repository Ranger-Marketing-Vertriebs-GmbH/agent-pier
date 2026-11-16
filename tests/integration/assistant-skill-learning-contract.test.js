import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { contractTimeout } from "../helpers/contract-timeout.js";
import { compiledShell } from "../helpers/assistant-shell-compiled.js";
import { createGatewaySession } from "../../server/features/assistants/runtimes/openclaw/session-create.js";
import { learningTool } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/skill-learning.js";
import { runtimeFor } from "../../server/features/assistants/runtimes/runtime-for.js";

// "Learns its own skills" against the pinned Gateway (ADR 0007, step 6): OpenClaw's
// review mode is Gateway-wide and its only per-agent lever is tool policy. AgentPier
// compiles `skill_workshop` for the agent that learns alone and the mode "auto" while
// one does; the Gateway must accept that configuration, offer the tool to that
// agent's sessions only (tools.effective and a real turn), take the change live in
// both directions and after a restart, and report a learned skill for its agent.
const installed = process.env.AGENTPIER_SHELL_CONTRACT_RUNTIME;
const options = {
  skip: !installed && "set AGENTPIER_SHELL_CONTRACT_RUNTIME",
  timeout: contractTimeout(300000),
};

// What the Gateway itself says a session of the agent may call.
async function effective(h, agentId, label) {
  const session = await createGatewaySession(h.runtime.client, { agentId, label });
  const result = await h.runtime.client.call("tools.effective", {
    agentId,
    sessionKey: session.key,
  });
  return (result.groups || []).flatMap((group) => group.tools.map((tool) => tool.id));
}

test(
  "the Gateway offers skill_workshop to the learning agent alone, in mode auto",
  options,
  async (t) => {
    const h = await compiledShell(t, installed, { prefix: "skill-learning-" });
    const { store } = h;
    const learner = h.create("Learner");
    const other = h.create("Other");
    const idOf = (agent) => store.getAssistant(agent.id).runtimeAgentId;
    const set = (agent, skillLearning) =>
      h.assistants.update(
        agent.id,
        { skillLearning },
        store.getAssistant(agent.id).revision,
      );
    const applyAll = async () => {
      for (const agent of [learner, other]) await h.config.apply(agent.id);
    };
    const state = async () => {
      const running = await h.running();
      return {
        mode: running.skills?.workshop?.autonomous?.mode,
        global: running.tools.allow.includes(learningTool),
        learner: running.agents.entries[idOf(learner)].tools.allow.includes(learningTool),
        other: running.agents.entries[idOf(other)].tools.allow.includes(learningTool),
      };
    };
    const off = { mode: "off", global: false, learner: false, other: false };
    const on = { mode: "auto", global: true, learner: true, other: false };

    // Nobody chose: exactly the configuration from before the option.
    await h.runtime.start();
    await applyAll();
    assert.deepEqual(await state(), off);
    const before = (await h.running()).tools.allow;
    for (const agent of [learner, other])
      assert.ok(
        !(await effective(h, idOf(agent), `off-${agent.name}`)).includes(learningTool),
      );

    // Switched on as the settings save it: live, without a restart.
    const generation = h.runtime.generation;
    await set(learner, true);
    assert.deepEqual(await state(), on);
    assert.equal(h.runtime.generation, generation, "no restart");
    const offered = await effective(h, idOf(learner), "on-learner");
    t.diagnostic(`learner effective=${JSON.stringify(offered)}`);
    assert.ok(offered.includes(learningTool), "the learner is offered skill_workshop");
    const others = await effective(h, idOf(other), "on-other");
    assert.ok(!others.includes(learningTool), "the other agent is not");
    // Nothing else widened: the global list gained this one tool.
    assert.deepEqual((await h.running()).tools.allow, [...before, learningTool]);
    // A real turn: the model is offered the tool for the learner only.
    const turn = await h.direct(idOf(learner), "learner-turn", "true");
    t.diagnostic(`learner turn offered=${JSON.stringify(turn.offered)}`);
    assert.ok(turn.offered.includes(learningTool));
    const plain = await h.direct(idOf(other), "other-turn", "true");
    assert.ok(!plain.offered.includes(learningTool));

    // A skill the learner saved (written here as skill_workshop stores one) is
    // reported for that agent alone, as its own.
    const skillDir = path.join(
      h.runtime.paths.state,
      "agents",
      idOf(learner),
      "agent",
      "workshop-skills",
      "deploy-staging",
    );
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: deploy-staging\ndescription: Deploy the staging stack and verify it.\n---\n\n# Deploy staging\n\n1. Run the deploy.\n",
    );
    const skills = runtimeFor(store.getAssistant(learner.id), h.runtime).skills;
    let learned;
    for (let n = 0; n < 60 && !learned; n++) {
      const report = await skills.status({ agentId: idOf(learner) });
      learned = report.skills.find((entry) => entry.name === "deploy-staging");
      if (!learned) await delay(500);
    }
    t.diagnostic(`learned entry=${JSON.stringify(learned)}`);
    assert.ok(learned, "skills.status reports the learned skill");
    assert.equal(learned.source, "openclaw-workshop");
    assert.equal(learned.origin, "local");
    assert.equal(learned.blockedByAgentFilter, false);
    const foreign = await skills.status({ agentId: idOf(other) });
    assert.ok(!foreign.skills.some((entry) => entry.name === "deploy-staging"));
    const page = await h.assistants.skills.list(learner.id);
    const row = page.skills.find((skill) => skill.name === "deploy-staging");
    assert.equal(row?.state, "selfWritten");
    assert.equal(row.active, true);

    // The Gateway accepts the compiled configuration at a start as well.
    await h.runtime.restart();
    await applyAll();
    assert.deepEqual(await state(), on);
    assert.ok(
      (await effective(h, idOf(learner), "restart-learner")).includes(learningTool),
    );

    // Off again: the last learner stops, so the tool and the mode go, live.
    await set(learner, false);
    assert.deepEqual(await state(), off);
    assert.ok(!(await effective(h, idOf(learner), "stopped")).includes(learningTool));
    await h.runtime.restart();
    await applyAll();
    assert.deepEqual(await state(), off);
  },
);

test(
  "a user's agent with a stored 'on' is never offered the tool",
  options,
  async (t) => {
    const h = await compiledShell(t, installed, { prefix: "skill-learning-user-" });
    const { store } = h;
    const learner = h.create("Learner");
    const user = h.create("User");
    // Written past the routes, which refuse it for a user agent.
    store.changeUserAgent(user.id, {
      skillLearning: true,
      userAccess: {
        mode: "shared",
        members: [{ userId: "user-fixture", level: "chat" }],
        released: [],
      },
    });
    store.changeUserAgent(learner.id, { skillLearning: true });
    await h.runtime.start();
    for (const agent of [learner, user]) await h.config.apply(agent.id);
    const running = await h.running();
    const idOf = (agent) => store.getAssistant(agent.id).runtimeAgentId;
    assert.equal(running.skills.workshop.autonomous.mode, "auto");
    assert.ok(running.agents.entries[idOf(learner)].tools.allow.includes(learningTool));
    assert.ok(!running.agents.entries[idOf(user)].tools.allow.includes(learningTool));
    const offered = await effective(h, idOf(user), "user-effective");
    t.diagnostic(`user effective=${JSON.stringify(offered)}`);
    assert.ok(!offered.includes(learningTool));
    const turn = await h.direct(idOf(user), "user-turn", "true");
    assert.ok(!turn.offered.includes(learningTool));
  },
);
