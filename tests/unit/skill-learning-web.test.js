import test from "node:test";
import assert from "node:assert/strict";
import {
  capabilityFormKeys,
  capabilityPatch,
  capabilityServer,
} from "../../web/features/assistants/settings/agent-settings-fields.js";
import { learningSwitch } from "../../web/features/assistants/settings/skill-learning-switch.js";
import {
  duplicateFields,
  emptyDraft,
  forUserAgent,
} from "../../web/features/assistants/wizard/wizard-draft.js";
import { createBody } from "../../web/features/assistants/wizard/wizard-creation.js";

// "Learns its own skills" in the web app (ADR 0007, step 6): the Capabilities tab's
// switch reads the effective value the server sends and the runtime's traits, never a
// runtime id.
const skills = (traits) => ({ capabilities: { skills: { available: true, ...traits } } });
const perAgent = skills({
  learnsByDefault: true,
  userAgentsLearn: true,
  writesWhenAsked: true,
});
const agent = (extra = {}) => ({
  id: "a1",
  name: "Home",
  revision: 2,
  capabilities: { memory: true },
  skillLearning: false,
  ...extra,
});
const userAccess = { mode: "own", members: [{ userId: "u1", level: "chat" }] };

test("the tab's draft holds the effective value and saves only a change", () => {
  assert.ok(capabilityFormKeys.includes("skillLearning"));
  const assistant = agent();
  const base = capabilityServer(assistant);
  assert.equal(base.skillLearning, false);
  assert.equal(capabilityServer(agent({ skillLearning: true })).skillLearning, true);
  // A view from before the field is "off", as the default runtime's agents are.
  assert.equal(capabilityServer({ id: "old" }).skillLearning, false);
  assert.deepEqual(capabilityPatch({ values: base, base, assistant }), {});
  assert.deepEqual(
    capabilityPatch({ values: { ...base, skillLearning: true }, base, assistant }),
    { skillLearning: true },
  );
});

test("a locked or following agent never sends the field", () => {
  const locked = agent({ userAccess, skillLearningLocked: "userAgent" });
  const base = capabilityServer(locked);
  assert.deepEqual(
    capabilityPatch({
      values: { ...base, skillLearning: true },
      base,
      assistant: locked,
    }),
    {},
  );
  const member = agent({ teamMemberId: "a1", lifetime: "task" });
  assert.deepEqual(
    capabilityPatch({
      values: { ...capabilityServer(member), skillLearning: true },
      base: capabilityServer(member),
      assistant: member,
    }),
    {},
  );
});

test("the switch shows for agents with settings of their own, locked with the reason", () => {
  assert.deepEqual(learningSwitch(agent()), {
    shown: true,
    locked: null,
    writesWhenAsked: false,
  });
  assert.deepEqual(learningSwitch(agent({ runtimeInfo: perAgent })), {
    shown: true,
    locked: null,
    writesWhenAsked: true,
  });
  assert.equal(
    learningSwitch(agent({ userAccess, skillLearningLocked: "userAgent" })).locked,
    "userAgent",
  );
  assert.equal(
    learningSwitch(agent({ skillLearningLocked: "channelBot" })).locked,
    "channelBot",
  );
  // A user's agent on a runtime that lets it learn has a working switch.
  assert.equal(learningSwitch(agent({ userAccess, runtimeInfo: perAgent })).locked, null);
  assert.equal(learningSwitch(agent({ archivedAt: "2026-11-01" })).shown, false);
  assert.equal(
    learningSwitch(agent({ teamMemberId: "a1", lifetime: "task" })).shown,
    false,
  );
  assert.equal(
    learningSwitch(agent({ teamMemberId: "a1", lifetime: "permanent" })).shown,
    true,
  );
  assert.equal(learningSwitch(null).shown, false);
});

test("a duplicate carries a choice that differs from its runtime's default", () => {
  const copy = (source) => duplicateFields(source, null, null, (name) => name);
  assert.equal(emptyDraft().skillLearning, null);
  assert.equal(copy(agent()).skillLearning, null);
  assert.equal(copy(agent({ skillLearning: true })).skillLearning, true);
  assert.equal(
    copy(agent({ skillLearning: true, runtimeInfo: perAgent })).skillLearning,
    null,
  );
  assert.equal(
    copy(agent({ skillLearning: false, runtimeInfo: perAgent })).skillLearning,
    false,
  );
});

test("the create body names learning only when the draft chose it", () => {
  const draft = {
    ...emptyDraft(),
    name: "Copy",
    connectionId: "c",
    modelId: "m",
  };
  assert.equal("skillLearning" in createBody(draft), false);
  assert.equal(createBody({ ...draft, skillLearning: true }).skillLearning, true);
  assert.equal(createBody({ ...draft, skillLearning: false }).skillLearning, false);
});

test("an agent for a user keeps learning only where its runtime lets users' agents learn", () => {
  const draft = { ...emptyDraft(), name: "Hers", connectionId: "c", modelId: "m" };
  const hers = (skillLearning, runtimeInfo) =>
    createBody(forUserAgent({ ...draft, owner: "u1", skillLearning }, runtimeInfo));
  // The default runtime refuses it (the server answers 409): "on" is not sent.
  assert.equal("skillLearning" in hers(true), false);
  assert.equal("skillLearning" in hers(true, { capabilities: {} }), false);
  // Off always travels.
  assert.equal(hers(false).skillLearning, false);
  // A runtime whose users' agents learn keeps an explicit choice either way.
  assert.equal(hers(true, perAgent).skillLearning, true);
  assert.equal(hers(false, perAgent).skillLearning, false);
  // The owner's own agent is untouched.
  assert.equal(
    createBody(forUserAgent({ ...draft, skillLearning: true })).skillLearning,
    true,
  );
});
