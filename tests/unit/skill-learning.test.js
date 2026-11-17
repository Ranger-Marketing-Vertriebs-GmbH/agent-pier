import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  learningLocked,
  learningView,
  learnsSkills,
  refuseLearning,
} from "../../server/features/assistants/skill-learning.js";
import { desiredAgent } from "../../server/features/assistants/agent-desired-state.js";
import {
  recompiles,
  validateDefinition,
} from "../../server/features/assistants/assistant-validation.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { withoutUnchanged } from "../../server/features/assistants/shell-changes.js";
import { traitOf } from "../../server/features/assistants/runtimes/runtime-descriptors.js";
import { DEFAULT_TRAITS } from "../../server/features/assistants/runtimes/runtime-traits.js";
import { RUNTIME_IDS } from "../../server/features/assistants/runtimes/runtime-descriptors.js";
import { settingsPatch } from "../../server/features/users/user-agent-settings.js";

// "Learns its own skills" (ADR 0007, step 6): one field of AgentPier's agent model.
// Unset means the runtime's default, so an agent from before the field behaves as it
// did. The second runtime of the registry is the one whose agents learn by default.
const [shared, perAgent] = RUNTIME_IDS;
const userAccess = {
  mode: "own",
  members: [{ userId: "u1", level: "extended" }],
  released: [],
};
const model = { connectionId: "c1", modelId: "m1" };
const agent = (extra = {}) => ({
  id: "a1",
  name: "Agent",
  runtimeAgentId: "ap-a1",
  runtime: shared,
  capabilities: { memory: true },
  ...extra,
});

test("the traits: the default runtime's agents do not learn unless switched on", () => {
  assert.deepEqual(DEFAULT_TRAITS.skills, {
    learnsByDefault: false,
    userAgentsLearn: false,
    writesWhenAsked: false,
    channelBotsLearn: false,
  });
  assert.equal(traitOf(agent(), "skills", "learnsByDefault"), false);
  const own = agent({ runtime: perAgent });
  assert.equal(traitOf(own, "skills", "learnsByDefault"), true);
  assert.equal(traitOf(own, "skills", "userAgentsLearn"), true);
  assert.equal(traitOf(own, "skills", "writesWhenAsked"), true);
});

test("the effective value is the stored one, else the runtime's default", () => {
  assert.equal(learnsSkills(agent()), false);
  assert.equal(learnsSkills(agent({ skillLearning: true })), true);
  assert.equal(learnsSkills(agent({ skillLearning: false })), false);
  assert.equal(learnsSkills(agent({ runtime: perAgent })), true);
  assert.equal(learnsSkills(agent({ runtime: perAgent, skillLearning: false })), false);
  // Anything but a boolean is "not set".
  assert.equal(learnsSkills(agent({ skillLearning: "yes" })), false);
  assert.equal(learnsSkills(agent({ runtime: perAgent, skillLearning: null })), true);
  // An agent without a recorded runtime runs on the default runtime.
  assert.equal(learnsSkills({ id: "old" }), false);
});

test("an agent of restricted users never learns where its runtime refuses it", () => {
  for (const mode of ["own", "shared"]) {
    const user = agent({ skillLearning: true, userAccess: { ...userAccess, mode } });
    assert.equal(learningLocked(user), true, mode);
    assert.equal(learnsSkills(user), false, mode);
    assert.equal(desiredAgent(user).skills.learning, false, mode);
  }
  // Where the runtime keeps learned skills inside the agent's own home, the field
  // works for a user's agent as for any other.
  const own = agent({ runtime: perAgent, userAccess });
  assert.equal(learningLocked(own), false);
  assert.equal(learnsSkills(own), true);
  assert.equal(learnsSkills({ ...own, skillLearning: false }), false);
});

test("refuseLearning refuses switching it on for a locked agent, with a stable key", () => {
  const user = agent({ userAccess });
  assert.throws(
    () => refuseLearning(user, { skillLearning: true }),
    (error) => error.status === 409 && error.code === "USER_AGENT_SKILL_LEARNING",
  );
  // Restating "off", another field, an owner's agent and the other runtime pass.
  refuseLearning(user, { skillLearning: false });
  refuseLearning(user, { name: "x" });
  refuseLearning(agent(), { skillLearning: true });
  refuseLearning(agent({ runtime: perAgent, userAccess }), { skillLearning: true });
});

test("the view carries the effective value and whether the switch is locked", () => {
  assert.equal(learningView(agent()).skillLearning, false);
  assert.equal("skillLearningLocked" in learningView(agent()), false);
  assert.equal(learningView(agent({ runtime: perAgent })).skillLearning, true);
  const locked = learningView(agent({ skillLearning: true, userAccess }));
  assert.equal(locked.skillLearning, false);
  assert.equal(locked.skillLearningLocked, "userAgent");
});

test("an agent with a bot for other people shows the switch locked where the runtime refuses it", () => {
  const mine = agent({ skillLearning: true });
  const view = learningView(mine, { senderFacing: true });
  assert.equal(view.skillLearning, false);
  assert.equal(view.skillLearningLocked, "channelBot");
  assert.equal(learnsSkills(mine, { senderFacing: true }), false);
  assert.equal(learningView(mine, { senderFacing: false }).skillLearning, true);
  // A user agent's own reason comes first.
  assert.equal(
    learningView(agent({ userAccess }), { senderFacing: true }).skillLearningLocked,
    "userAgent",
  );
  // The runtime whose bots leave the agent's other chats out keeps the switch.
  const own = learningView(agent({ runtime: perAgent }), { senderFacing: true });
  assert.equal(own.skillLearning, true);
  assert.equal("skillLearningLocked" in own, false);
  assert.equal(traitOf(own, "skills", "channelBotsLearn"), true);
  assert.equal(traitOf(agent(), "skills", "channelBotsLearn"), false);
});

test("the desired state names learning; a task member follows its lead", () => {
  assert.equal(desiredAgent(agent()).skills.learning, false);
  assert.equal(desiredAgent(agent({ skillLearning: true })).skills.learning, true);
  assert.equal(desiredAgent(agent({ runtime: perAgent })).skills.learning, true);
  const lead = agent({ id: "lead", runtime: perAgent, skillLearning: false });
  const member = agent({
    id: "m1",
    runtime: perAgent,
    teamMemberId: "m1",
    parentAssistantId: "lead",
    inherited: { capabilities: {} },
  });
  assert.equal(desiredAgent(member, { lead }).skills.learning, false);
  assert.equal(desiredAgent(member).skills.learning, true);
});

test("the definition takes a boolean skillLearning and recompiles on it", () => {
  assert.equal(validateDefinition({ skillLearning: true }, true).skillLearning, true);
  assert.equal(
    validateDefinition({ name: "A", model, skillLearning: false }).skillLearning,
    false,
  );
  assert.equal("skillLearning" in validateDefinition({ name: "A", model }), false);
  for (const value of [null, "on", 1])
    assert.throws(() => validateDefinition({ skillLearning: value }, true));
  assert.equal(recompiles({ skillLearning: false }), true);
});

test("an unchanged effective value is no change of a form's patch", () => {
  const kept = (current, value) =>
    "skillLearning" in
    withoutUnchanged({ skillLearning: value }, { skillLearning: value }, current);
  assert.equal(kept(agent(), false), false);
  assert.equal(kept(agent(), true), true);
  assert.equal(kept(agent({ runtime: perAgent }), true), false);
  assert.equal(kept(agent({ runtime: perAgent }), false), true);
});

function store(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-learning-"));
  const assistants = new AssistantStore({ dataDir });
  t.after(() => {
    assistants.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return assistants;
}

test("the store keeps the field unset until it is chosen", (t) => {
  const assistants = store(t);
  const created = assistants.createAssistant({ name: "A", model });
  assert.equal("skillLearning" in created, false);
  const on = assistants.updateAssistant(created.id, { skillLearning: true }, 1);
  assert.equal(on.skillLearning, true);
  assert.equal(assistants.getAssistant(created.id).skillLearning, true);
  const chosen = assistants.createAssistant({ name: "B", model, skillLearning: true });
  assert.equal(chosen.skillLearning, true);
});

test("the store refuses learning for a user agent on create and update", (t) => {
  const assistants = store(t);
  const refused = (error) => error.code === "USER_AGENT_SKILL_LEARNING";
  // Create: also what a duplicate and a template-based agent run through.
  assert.throws(
    () =>
      assistants.createAssistant(
        { name: "U", model, skillLearning: true },
        { userAccess },
      ),
    refused,
  );
  assert.throws(
    () =>
      assistants.createAssistant(
        { name: "T", model, skillLearning: true },
        { template: { id: "t", revision: "r" }, userAccess },
      ),
    refused,
  );
  assert.equal(assistants.listAssistants().length, 0);
  const user = assistants.createAssistant(
    { name: "U", model, skillLearning: false },
    { userAccess },
  );
  assert.throws(
    () => assistants.updateAssistant(user.id, { skillLearning: true }, 1),
    refused,
  );
  assert.equal(assistants.getAssistant(user.id).revision, 1);
  // The per-agent runtime's user agents take the field.
  const own = assistants.createAssistant(
    { name: "H", model, runtime: perAgent, skillLearning: false },
    { userAccess },
  );
  assert.equal(
    assistants.updateAssistant(own.id, { skillLearning: true }, 1).skillLearning,
    true,
  );
});

test("an agent that comes to serve users loses a stored 'on'", (t) => {
  const assistants = store(t);
  const mine = assistants.createAssistant({ name: "A", model, skillLearning: true });
  // Written past the routes (an owner's agent never becomes a user agent there).
  const shared = { ...userAccess, mode: "shared" };
  assistants.changeUserAgent(mine.id, { userAccess: shared });
  const read = assistants.getAssistant(mine.id);
  assert.equal(learnsSkills(read), false);
  assert.equal(desiredAgent(read).skills.learning, false);
  // A new assignment drops the stored value, so it cannot return unnoticed.
  const assigned = assistants.setUserAccess(mine.id, shared, read.revision);
  assert.equal("skillLearning" in assigned, false);
});

test("a task member may only restate its effective value", (t) => {
  const assistants = store(t);
  const lead = assistants.createAssistant({ name: "L", model });
  const member = assistants.reserveMember({
    id: "m1",
    parent: lead.id,
    assignment: { name: "M" },
    snapshot: { model, instructions: "" },
    teamId: "t1",
    lifetime: "task",
  });
  assert.throws(() => assistants.updateAssistant(member.id, { skillLearning: true }, 1));
  const same = assistants.updateAssistant(member.id, { skillLearning: false }, 1);
  assert.equal("skillLearning" in same, false);
});

test("a user never changes the switch herself", () => {
  const own = agent({ userAccess });
  assert.throws(
    () => settingsPatch(own, "extended", { skillLearning: true }),
    (error) => error.status === 400,
  );
});
