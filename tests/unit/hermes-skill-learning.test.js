import test from "node:test";
import assert from "node:assert/strict";
import { compileHome } from "../../server/features/assistants/runtimes/hermes/hermes-config/home.js";
import { readHermesConfig } from "../../server/features/assistants/runtimes/hermes/hermes-config/home-merge.js";
import { hermesDescriptor } from "../../server/features/assistants/runtimes/hermes/descriptor.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";

// "Learns its own skills" on Hermes (agent/agent_init.py and agent/turn_finalizer.py
// of the pinned 0.23.3): `skills.creation_nudge_interval` (code default 10) counts
// tool iterations until the background review looks for a skill to write; 0 never
// starts it. Off writes 0, on leaves the key out. `skill_manage`, the memory review
// and the curator stay as they are.
const key = "creation_nudge_interval";
const profile = (extra = {}) => ({
  id: "a1",
  name: "Agent",
  runtimeAgentId: "ap-a1",
  runtime: hermesDescriptor.id,
  capabilities: { memory: true },
  ...extra,
});
const home = (agent, options) => compileHome(desiredAgent(agent), options);
const configOf = (compiled) => readHermesConfig(compiled.files["config.yaml"]);

test("an agent that never chose keeps a home without the key", () => {
  const compiled = home(profile());
  assert.equal(compiled.files["config.yaml"].includes(key), false);
  assert.equal(key in configOf(compiled).skills, false);
  // Exactly the file an agent of before the field compiled to.
  const { skillLearning: _unset, ...before } = profile();
  assert.equal(
    compiled.files["config.yaml"],
    compileHome(desiredAgent(before)).files["config.yaml"],
  );
  assert.equal(
    home(profile({ skillLearning: true })).files["config.yaml"],
    compiled.files["config.yaml"],
  );
});

test("learning off writes the interval 0 and changes nothing else", () => {
  const on = configOf(home(profile()));
  const off = configOf(home(profile({ skillLearning: false })));
  assert.equal(off.skills[key], 0);
  const { [key]: _interval, ...skills } = off.skills;
  assert.deepEqual({ ...off, skills }, on);
  // The agent can still write a skill when asked; memory and its review stay.
  assert.deepEqual(off.agent.disabled_toolsets, on.agent.disabled_toolsets);
  assert.equal(off.agent.disabled_toolsets.includes("skills"), false);
  assert.equal(off.memory.memory_enabled, true);
  assert.equal("nudge_interval" in off.memory, false);
  assert.equal("curator" in off, false);
  assert.equal("auxiliary" in off, false);
});

test("switching it back on removes the key AgentPier wrote", () => {
  const off = home(profile({ skillLearning: false }));
  const again = home(profile({ skillLearning: true }), {
    existing: { "config.yaml": off.files["config.yaml"] },
  });
  assert.equal(key in configOf(again).skills, false);
  // Keys Hermes wrote itself stay where they were (home-merge.js).
  const kept = home(profile({ skillLearning: false }), {
    existing: {
      "config.yaml": "_config_version: 12\nskills:\n  guard_agent_created: true\n",
    },
  });
  assert.equal(configOf(kept)._config_version, 12);
  assert.equal(configOf(kept).skills.guard_agent_created, true);
  assert.equal(configOf(kept).skills[key], 0);
});

test("a user's agent takes the field on Hermes as any other", () => {
  const userAccess = {
    mode: "own",
    members: [{ userId: "u1", level: "chat" }],
    released: [],
  };
  assert.equal(key in configOf(home(profile({ userAccess }))).skills, false);
  assert.equal(
    configOf(home(profile({ userAccess, skillLearning: false }))).skills[key],
    0,
  );
});
