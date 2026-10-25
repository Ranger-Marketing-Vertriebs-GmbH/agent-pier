import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DreamingSettings } from "../../server/features/assistants/dreaming-settings.js";
import {
  DREAMING_MEMORY_CONFIRMATION_REQUIRED,
  DreamingService,
} from "../../server/features/assistants/dreaming-service.js";
import { shellService } from "../helpers/assistant-shell-service.js";

const night = { enabled: true, hour: 3, timeZone: "Europe/Berlin" };
const dreamingPatches = (f) =>
  f.client.patches.filter((p) => p.patch.plugins?.entries?.["memory-core"]);

// A has memory, B has none, T is a temporary member of A without memory of its own,
// C is archived without memory.
function dreaming(t) {
  const f = shellService(t, ["A", "B", "C"]);
  const [a, b, c] = f.agents;
  f.store.updateAssistant(
    a.id,
    { capabilities: { memory: true, reminders: false } },
    a.revision,
  );
  const member = f.store.reserveMember({
    id: "member-t",
    parent: a.id,
    assignment: { name: "T" },
    snapshot: { model: { connectionId: "c", modelId: "m" }, instructions: "" },
    teamId: "team",
    lifetime: "temporary",
  });
  const archived = {
    ...f.store.getAssistant(c.id),
    archivedAt: new Date().toISOString(),
  };
  f.store.db
    .prepare("UPDATE assistants SET body=?,revision=? WHERE id=?")
    .run(JSON.stringify({ ...archived, revision: 2 }), 2, c.id);
  const settings = new DreamingSettings({ dataDir: f.dataDir });
  t.after(() => settings.close());
  const service = new DreamingService({ settings, assistants: f.service });
  return { ...f, a, b, c, member, settings, dreaming: service };
}

test("switching on asks first and names the agents without memory", async (t) => {
  const f = dreaming(t);
  assert.deepEqual(f.dreaming.get().withoutMemory, [{ id: f.b.id, name: "B" }]);
  await assert.rejects(f.dreaming.save(night, 1), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.key, "dreamingMemoryConfirm");
    assert.equal(error.code, DREAMING_MEMORY_CONFIRMATION_REQUIRED);
    assert.deepEqual(error.agents, [{ id: f.b.id, name: "B" }]);
    return true;
  });
  assert.equal(f.settings.get().enabled, false);
  assert.equal(f.dreaming.enabled(), false);
  assert.equal(f.store.getAssistant(f.b.id).capabilities?.memory ?? false, false);
  assert.deepEqual(dreamingPatches(f), []);
});

test("the confirmation turns memory on and then dreaming", async (t) => {
  const f = dreaming(t);
  const memberBefore = f.store.getAssistant(f.member.id);
  const saved = await f.dreaming.save({ ...night, confirmMemory: true }, 1);
  assert.equal(f.store.getAssistant(f.b.id).capabilities.memory, true);
  assert.deepEqual(f.store.getAssistant(f.member.id), memberBefore, "T unchanged");
  assert.equal(f.store.getAssistant(f.c.id).capabilities?.memory ?? false, false);
  assert.equal(saved.enabled, true);
  assert.equal(saved.pending, undefined);
  assert.deepEqual(saved.withoutMemory, []);
  assert.equal(f.dreaming.enabled(), true);
  const patches = dreamingPatches(f);
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0].patch.plugins.entries["memory-core"].config.dreaming, {
    enabled: true,
    frequency: "0 3 * * *",
    timezone: "Europe/Berlin",
    storage: { mode: "separate" },
  });
  assert.deepEqual(patches[0].replacePaths, [
    "plugins.entries.memory-core.config.dreaming",
  ]);
});

test("a busy agent keeps dreaming off and is named", async (t) => {
  const f = dreaming(t);
  const chat = f.store.saveConversation({
    assistantId: f.b.id,
    runtimeSessionKey: "b-chat",
  });
  const request = f.service.ledger.accept(chat.id, {
    clientRequestId: crypto.randomUUID(),
    text: "Working",
  });
  f.service.ledger.recordAttempt(request.id);
  await assert.rejects(f.dreaming.save({ ...night, confirmMemory: true }, 1), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.key, "dreamingAgentsBusy");
    assert.deepEqual(error.agents, [{ id: f.b.id, name: "B" }]);
    return true;
  });
  assert.equal(f.settings.get().enabled, false);
  assert.equal(f.store.getAssistant(f.b.id).capabilities?.memory ?? false, false);
  assert.deepEqual(dreamingPatches(f), []);
});

test("an error other than busy propagates and leaves dreaming off", async (t) => {
  const f = dreaming(t);
  const refused = Object.assign(new Error("boom"), { key: "invalid", status: 400 });
  const update = f.service.update.bind(f.service);
  f.service.update = async (id, ...rest) => {
    if (id === f.b.id) throw refused;
    return update(id, ...rest);
  };
  await assert.rejects(f.dreaming.save({ ...night, confirmMemory: true }, 1), refused);
  assert.equal(f.settings.get().enabled, false);
});

test("changing the hour while on patches once and needs no confirmation", async (t) => {
  const f = dreaming(t);
  const on = await f.dreaming.save({ ...night, confirmMemory: true }, 1);
  const saved = await f.dreaming.save({ ...night, hour: 5 }, on.revision);
  assert.equal(saved.hour, 5);
  const patches = dreamingPatches(f);
  assert.equal(patches.length, 2);
  assert.equal(
    patches[1].patch.plugins.entries["memory-core"].config.dreaming.frequency,
    "0 5 * * *",
  );
});

test("switching off needs no confirmation and leaves memory on", async (t) => {
  const f = dreaming(t);
  const on = await f.dreaming.save({ ...night, confirmMemory: true }, 1);
  const off = await f.dreaming.save({ ...night, enabled: false }, on.revision);
  assert.equal(off.enabled, false);
  assert.equal(f.store.getAssistant(f.b.id).capabilities.memory, true);
  const patches = dreamingPatches(f);
  assert.equal(patches.length, 2);
  assert.deepEqual(patches[1].patch.plugins.entries["memory-core"].config.dreaming, {
    enabled: false,
  });
});

test("switching off with agents without memory needs no confirmation", async (t) => {
  const f = dreaming(t);
  const off = await f.dreaming.save({ ...night, enabled: false, hour: 4 }, 1);
  assert.equal(off.hour, 4);
  assert.equal(f.store.getAssistant(f.b.id).capabilities?.memory ?? false, false);
});

test("a stopped Gateway saves and reports pending", async (t) => {
  const f = dreaming(t);
  f.client.ready = false;
  const saved = await f.dreaming.save({ ...night, confirmMemory: true }, 1);
  assert.equal(saved.enabled, true);
  assert.equal(saved.pending, true);
  assert.equal(f.settings.get().enabled, true);
  assert.deepEqual(dreamingPatches(f), []);
});

test("a stale revision or invalid input is refused before memory is raised", async (t) => {
  const f = dreaming(t);
  await assert.rejects(f.dreaming.save({ ...night, confirmMemory: true }, 7), {
    status: 409,
    key: "conflict",
  });
  await assert.rejects(f.dreaming.save({ ...night, hour: 24, confirmMemory: true }, 1), {
    status: 400,
  });
  assert.equal(f.store.getAssistant(f.b.id).capabilities?.memory ?? false, false);
});
