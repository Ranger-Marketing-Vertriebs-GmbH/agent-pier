import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { DreamingSettings } from "../../server/features/assistants/dreaming-settings.js";
import {
  DREAMING_AGENTS_BUSY,
  DREAMING_MEMORY_CONFIRMATION_REQUIRED,
  DreamingService,
} from "../../server/features/assistants/dreaming-service.js";
import { DreamingBackups } from "../../server/features/assistants/dreaming-backups.js";
import { shellService } from "../helpers/assistant-shell-service.js";

const night = { enabled: true, hour: 3, timeZone: "Europe/Berlin" };
const dreamingPatches = (f) =>
  f.client.patches.filter((p) => p.patch.plugins?.entries?.["memory-core"]);

// A has memory, B (and D, when named) has none, T is a temporary member of A without
// memory of its own, C is archived without memory. Agents are raised in `names` order.
function dreaming(t, names = ["A", "B", "C"]) {
  const f = shellService(t, names);
  const by = Object.fromEntries(
    f.agents.map((agent) => [agent.name.toLowerCase(), agent]),
  );
  const { a, c } = by;
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
  const warnings = [];
  const service = new DreamingService({
    settings,
    assistants: f.service,
    warn: (line) => warnings.push(line),
  });
  return { ...f, ...by, member, settings, dreaming: service, warnings };
}
const hasMemory = (f, agent) =>
  f.store.getAssistant(agent.id).capabilities?.memory === true;

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

test("a busy agent keeps dreaming off and is named; the others keep memory", async (t) => {
  const f = dreaming(t, ["A", "B", "C", "D"]);
  const chat = f.store.saveConversation({
    assistantId: f.b.id,
    runtimeSessionKey: "b-chat",
  });
  const request = f.service.ledger.accept(chat.id, {
    clientRequestId: crypto.randomUUID(),
    text: "Working",
  });
  const attempt = f.service.ledger.recordAttempt(request.id);
  await assert.rejects(f.dreaming.save({ ...night, confirmMemory: true }, 1), (error) => {
    assert.equal(error.status, 409);
    assert.equal(error.key, "dreamingAgentsBusy");
    assert.equal(error.code, DREAMING_AGENTS_BUSY);
    assert.deepEqual(error.agents, [{ id: f.b.id, name: "B" }]);
    return true;
  });
  assert.equal(f.settings.get().enabled, false);
  assert.equal(hasMemory(f, f.b), false);
  assert.equal(hasMemory(f, f.d), true, "D was raised although B was busy");
  assert.deepEqual(dreamingPatches(f), []);
  // Once B is done, the retry raises B only and switches dreaming on.
  f.service.ledger.transition(attempt.id, "completed");
  const saved = await f.dreaming.save({ ...night, confirmMemory: true }, 1);
  assert.equal(saved.enabled, true);
  assert.equal(hasMemory(f, f.b), true);
  assert.equal(dreamingPatches(f).length, 1);
});

test("an error other than busy propagates and leaves dreaming off", async (t) => {
  const f = dreaming(t, ["A", "D", "B", "C"]);
  const refused = Object.assign(new Error("boom"), { key: "invalid", status: 400 });
  const update = f.service.update.bind(f.service);
  const raised = [];
  f.service.update = async (id, ...rest) => {
    raised.push(id);
    if (id === f.b.id) throw refused;
    return update(id, ...rest);
  };
  await assert.rejects(f.dreaming.save({ ...night, confirmMemory: true }, 1), refused);
  assert.deepEqual(raised, [f.d.id, f.b.id], "D is raised before B");
  assert.equal(hasMemory(f, f.d), true, "D keeps memory");
  assert.equal(f.settings.get().enabled, false);
  assert.deepEqual(dreamingPatches(f), []);
});

test("a failed live apply keeps the setting, reports pending and logs the code", async (t) => {
  const f = dreaming(t);
  const on = await f.dreaming.save({ ...night, confirmMemory: true }, 1);
  f.client.answers["config.patch"] = Object.assign(new Error("secret-value"), {
    code: "UNAVAILABLE",
  });
  const saved = await f.dreaming.save({ ...night, hour: 6 }, on.revision);
  assert.equal(saved.hour, 6);
  assert.equal(saved.pending, true);
  assert.equal(f.settings.get().hour, 6);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /UNAVAILABLE/);
  assert.doesNotMatch(f.warnings[0], /secret-value/);
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

// The one-minute backup tick, wired as in assistant-graph.js.
function ticking(f) {
  f.service.dreaming = f.dreaming;
  return new DreamingBackups(f.dreaming);
}
const gatewayDreaming = (f) =>
  f.client.effective().plugins?.entries?.["memory-core"]?.config?.dreaming;

test("a save while the Gateway is not ready reaches it at the next tick", async (t) => {
  const f = dreaming(t);
  const backups = ticking(f);
  f.client.ready = false;
  const saved = await f.dreaming.save({ ...night, confirmMemory: true }, 1);
  assert.equal(saved.pending, true);
  await backups.run();
  assert.deepEqual(dreamingPatches(f), [], "not while the Gateway is not ready");
  f.client.ready = true;
  await backups.run();
  assert.equal(dreamingPatches(f).length, 1);
  assert.deepEqual(gatewayDreaming(f), {
    enabled: true,
    frequency: "0 3 * * *",
    timezone: "Europe/Berlin",
    storage: { mode: "separate" },
  });
  assert.equal(f.dreaming.pending, false);
  await backups.run();
  assert.equal(dreamingPatches(f).length, 1, "applied once");
});

test("a switch-off the Gateway refused is applied at the next tick", async (t) => {
  const f = dreaming(t);
  const backups = ticking(f);
  const on = await f.dreaming.save({ ...night, confirmMemory: true }, 1);
  f.client.answers["config.patch"] = Object.assign(new Error("refused"), {
    code: "UNAVAILABLE",
  });
  const off = await f.dreaming.save({ ...night, enabled: false }, on.revision);
  assert.equal(off.pending, true);
  assert.equal(gatewayDreaming(f).enabled, true, "the Gateway still dreams");
  await backups.run();
  assert.equal(f.dreaming.pending, true, "still refused: kept for the next tick");
  delete f.client.answers["config.patch"];
  await backups.run();
  // The double merges; OpenClaw replaces the path (replacePaths).
  assert.equal(gatewayDreaming(f).enabled, false);
  const last = dreamingPatches(f).at(-1);
  assert.deepEqual(last.patch.plugins.entries["memory-core"].config.dreaming, {
    enabled: false,
  });
  assert.deepEqual(last.replacePaths, ["plugins.entries.memory-core.config.dreaming"]);
  assert.equal(f.dreaming.pending, false);
  assert.equal(f.warnings.length, 1, "the tick retries without logging again");
});

test("a pending change the Gateway already holds is not patched again", async (t) => {
  const f = dreaming(t);
  const backups = ticking(f);
  const on = await f.dreaming.save({ ...night, confirmMemory: true }, 1);
  f.client.ready = false;
  await f.dreaming.save({ ...night, hour: 5 }, on.revision);
  // A Gateway start compiles the saved setting: nothing is left pending.
  assert.deepEqual(f.dreaming.compiled(), { ...night, hour: 5 });
  assert.equal(f.dreaming.pending, false);
  f.client.ready = true;
  await backups.run();
  assert.equal(dreamingPatches(f).length, 1, "only the switch-on was patched");
});

test("the raise sends known boolean capabilities only", async (t) => {
  const f = dreaming(t);
  const b = f.store.getAssistant(f.b.id);
  const body = {
    ...b,
    capabilities: { memory: false, reminders: false, documents: "yes", legacy: true },
    revision: b.revision + 1,
  };
  f.store.db
    .prepare("UPDATE assistants SET body=?,revision=? WHERE id=?")
    .run(JSON.stringify(body), body.revision, b.id);
  const sent = [];
  const update = f.service.update.bind(f.service);
  f.service.update = (id, patch, ...rest) => {
    sent.push(patch.capabilities);
    return update(id, patch, ...rest);
  };
  const saved = await f.dreaming.save({ ...night, confirmMemory: true }, 1);
  assert.equal(saved.enabled, true);
  assert.deepEqual(sent, [{ memory: true, reminders: false }]);
  assert.equal(hasMemory(f, f.b), true);
});
