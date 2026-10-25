import test from "node:test";
import assert from "node:assert/strict";
import { memoryRequirement } from "../../server/features/assistants/memory-rules.js";
import { UserAgents } from "../../server/features/users/user-agents.js";
import { shellService } from "../helpers/assistant-shell-service.js";

const model = { connectionId: "c", modelId: "m" };
const memoryOff = { capabilities: { memory: false, reminders: false } };
const refusedForDreaming = (error) => {
  assert.equal(error.status, 409);
  assert.equal(error.key, "dreamingMemoryRequired");
  return true;
};

// The service reads the owner's switch from `dreaming` (assistant-graph.js).
function lock(t) {
  const f = shellService(t, ["A"]);
  const switchState = { on: false };
  f.service.dreaming = { enabled: () => switchState.on };
  const [a] = f.agents;
  const raised = f.store.updateAssistant(
    a.id,
    { capabilities: { memory: true, reminders: false } },
    a.revision,
  );
  return { ...f, a: raised, switchState };
}
const member = (f, lifetime) =>
  f.store.reserveMember({
    id: `member-${lifetime}`,
    parent: f.a.id,
    assignment: { name: lifetime },
    snapshot: { model, instructions: "" },
    teamId: "team",
    lifetime,
  });

test("memory cannot be switched off while dreaming is on", async (t) => {
  const f = lock(t);
  f.switchState.on = true;
  await assert.rejects(
    f.service.update(f.a.id, memoryOff, f.a.revision),
    refusedForDreaming,
  );
  assert.equal(f.store.getAssistant(f.a.id).capabilities.memory, true);
  f.switchState.on = false;
  const saved = await f.service.update(f.a.id, memoryOff, f.a.revision);
  assert.equal(saved.capabilities.memory, false);
});

test("a temporary member is not held by the dreaming rule", (t) => {
  const f = lock(t);
  const temporary = member(f, "task");
  const patch = { capabilities: { memory: false } };
  assert.equal(memoryRequirement(temporary, patch, { dreaming: true }), null);
  assert.equal(
    memoryRequirement(f.store.getAssistant(f.a.id), patch, { dreaming: true }),
    "dreamingMemoryRequired",
  );
  assert.equal(
    memoryRequirement(f.store.getAssistant(f.a.id), patch, { dreaming: false }),
    null,
  );
});

test("new agents remember by default", async (t) => {
  const f = lock(t);
  const plain = await f.service.create({ name: "Plain", instructions: "", model });
  assert.equal(plain.capabilities.memory, true);
  assert.equal(plain.capabilities.reminders, false);
  const partial = await f.service.create({
    name: "Partial",
    instructions: "",
    model,
    capabilities: { reminders: true },
  });
  assert.deepEqual(partial.capabilities, { memory: true, reminders: true });
  const off = await f.service.create({
    name: "Off",
    instructions: "",
    model,
    ...memoryOff,
  });
  assert.equal(off.capabilities.memory, false);
  f.switchState.on = true;
  await assert.rejects(
    f.service.create({ name: "Refused", instructions: "", model, ...memoryOff }),
    refusedForDreaming,
  );
  assert.equal(
    f.store.listAssistants().some((agent) => agent.name === "Refused"),
    false,
  );
});

test("a new agent's web capabilities still start off", async (t) => {
  const f = lock(t);
  const created = await f.service.create({
    name: "Web",
    instructions: "",
    model,
    capabilities: { memory: true, reminders: false, webSearch: true, webFetch: true },
  });
  assert.deepEqual(created.capabilities, {
    memory: true,
    reminders: false,
    webSearch: false,
    webFetch: false,
  });
});

test("a team approved as permanent starts its members with memory", (t) => {
  const f = lock(t);
  const permanent = member(f, "permanent");
  assert.deepEqual(f.store.getAssistant(permanent.id).capabilities, {
    memory: true,
    reminders: false,
  });
  const temporary = member(f, "task");
  assert.equal("capabilities" in f.store.storedAssistant(temporary.id), false);
});

test("users' agents remember by default", async (t) => {
  const f = lock(t);
  const users = { get: (id) => ({ id }) };
  const userAgents = new UserAgents({ assistants: f.service, users });
  const userAccess = { mode: "own", members: [{ userId: "anna", level: "chat" }] };
  const created = await userAgents.create({
    name: "Anna's agent",
    instructions: "",
    model,
    userAccess,
  });
  assert.equal(created.capabilities.memory, true);
  f.switchState.on = true;
  await assert.rejects(
    userAgents.create({ name: "Off", instructions: "", model, userAccess, ...memoryOff }),
    refusedForDreaming,
  );
});

test("an agent whose memory is still off may save other changes while dreaming is on", async (t) => {
  const f = lock(t);
  const off = f.store.updateAssistant(f.a.id, memoryOff, f.a.revision);
  f.switchState.on = true;
  // An unrelated change states memory as it is (off): not a switch-off.
  const patch = { capabilities: { memory: false, reminders: true } };
  assert.equal(memoryRequirement(off, patch, { dreaming: true }), null);
  const saved = await f.service.update(f.a.id, patch, off.revision);
  assert.equal(saved.capabilities.reminders, true);
  assert.equal(saved.capabilities.memory, false);
  // Turning memory on still works, and from then on it stays on.
  const on = await f.service.update(
    f.a.id,
    { capabilities: { memory: true, reminders: true } },
    saved.revision,
  );
  await assert.rejects(
    f.service.update(
      f.a.id,
      { capabilities: { memory: false, reminders: true } },
      on.revision,
    ),
    refusedForDreaming,
  );
});
