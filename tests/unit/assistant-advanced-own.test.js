import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { AdvancedConfig } from "../../server/features/assistants/advanced-config.js";
import { OverrideStore } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/overrides.js";
import {
  RuntimeSettingStore,
  ownSettings,
} from "../../server/features/assistants/runtimes/runtime-settings.js";
import { advancedRuntimes } from "../../server/features/assistants/runtimes/runtime-for.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";
import { desiredState } from "../../server/features/assistants/agent-desired-state.js";
import {
  fixtureCompiler,
  fixtureDescriptor,
  fixtureFields,
  fixtureRuntime,
} from "../helpers/runtime-fixture.js";

// ADR 0007, step 4: a runtime's own advanced settings, end to end with a runtime only
// tests know: listed with their stored and default values, validated against the
// descriptor, stored by runtime id and field id, applied as each field's `apply`
// says, and handed to the runtime's compiler. The shared settings:
// assistant-advanced-config.test.js, assistant-advanced-hermes.test.js.

function setup({ fixture = {}, shipped = true } = {}) {
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  const overrides = new OverrideStore(db);
  const settings = new RuntimeSettingStore(db);
  const runtime = { status: () => ({ availability: "disabled", version: null }) };
  const audit = [];
  const applied = [];
  const asked = { restarts: 0 };
  const profiles = [
    { id: "f1", runtime: "fixture" },
    { id: "f2", runtime: "fixture", archivedAt: "2026-11-01" },
    { id: "o1" },
  ];
  const own = fixtureRuntime({ applied, ...fixture });
  const advanced = new AdvancedConfig({
    assistants: {
      runtime,
      admit: async (operation) => operation(),
      store: { listAssistants: () => profiles },
      config: { apply: async () => {} },
    },
    overrides,
    settings,
    synchronization: { restartGateway: async (operation) => operation() },
    usage: () => ({ agents: [{ id: "f1", name: "Fix" }], teamMembers: 0 }),
    audit: { append: (entry) => audit.push(entry) },
    // The shipped runtimes, then the fixture.
    runtimes: (supervisor) => [...(shipped ? advancedRuntimes(supervisor) : []), own],
  });
  return { advanced, overrides, settings, db, audit, applied, asked };
}

const fixtureOf = ({ runtimes }) => runtimes.find((runtime) => runtime.id === "fixture");
const valuesOf = (listed) =>
  Object.fromEntries(fixtureOf(listed).own.map((field) => [field.id, field.value]));

test("the page lists each runtime, and a runtime's own settings with their values", async () => {
  const { advanced, settings } = setup();
  settings.set("fixture", "workers", 4);
  const listed = await advanced.get();
  assert.deepEqual(
    listed.runtimes.map((runtime) => runtime.id),
    ["openclaw", "hermes", "fixture"],
  );
  const { own, ...fixture } = fixtureOf(listed);
  assert.deepEqual(fixture, {
    id: "fixture",
    name: "Fixture Runtime",
    shortName: "Fixture",
    process: "perAgent",
    enabled: true,
    running: true,
    version: "1.0.0",
    qualified: true,
    // The archived agent and the other runtimes' agents do not count.
    agents: 1,
  });
  // Each field as the descriptor states it, under its surface, with the stored value
  // (null: the default applies). No text: labels are the web catalogs'.
  assert.deepEqual(
    own,
    fixtureFields.map((field) => ({
      surface: "tuning",
      ...field,
      value: field.id === "workers" ? 4 : null,
    })),
  );
  // The shipped runtimes describe no setting of their own.
  for (const runtime of listed.runtimes.slice(0, 2)) assert.deepEqual(runtime.own, []);
  // The shared settings are untouched by a runtime that takes none.
  assert.equal(listed.settings.length, 6);
  assert.ok(listed.settings.every((s) => !Object.hasOwn(s.runtimes, "fixture")));
});

test("a runtime states how it takes a shared setting; the row names it", async () => {
  const taken = [{ id: "thinkingDefault", path: "reasoning", reloadKind: "restart" }];
  const { advanced } = setup({
    fixture: {
      taken: {
        runtime: "1.0.0",
        list: taken,
        byId: (id) => taken.find((s) => s.id === id),
      },
    },
  });
  const { settings } = await advanced.get();
  assert.deepEqual(settings.find((s) => s.id === "thinkingDefault").runtimes.fixture, {
    apply: "restart",
    available: true,
    current: null,
  });
  assert.equal(settings.find((s) => s.id === "runTimeout").runtimes.fixture, undefined);
});

test("an own setting is validated against its description before anything is stored", async () => {
  const { advanced, settings, applied } = setup();
  for (const [runtime, field, value] of [
    ["fixture", "retired", true],
    ["next", "workers", 2],
    ["openclaw", "workers", 2],
    ["fixture", "toString", 2],
    ["fixture", "workers", 64],
    ["fixture", "workers", "2"],
    ["fixture", "effort", "medium"],
    ["fixture", "delegation", "yes"],
    ["fixture", "greeting", { text: "x" }],
  ])
    await assert.rejects(
      advanced.saveOwn(runtime, field, value),
      { status: 400, key: "invalid" },
      `${runtime}.${field}`,
    );
  assert.deepEqual(settings.list("fixture"), []);
  assert.deepEqual(applied, []);
});

test("a live or next-turn field is stored and reaches the runtime at once", async () => {
  const { advanced, settings, overrides, applied, audit } = setup();
  const saved = await advanced.saveOwn("fixture", "effort", "high");
  assert.equal(valuesOf(saved).effort, "high");
  await advanced.saveOwn("fixture", "delegation", true);
  assert.deepEqual(settings.list("fixture"), [
    { field: "delegation", value: true, revision: 1 },
    { field: "effort", value: "high", revision: 1 },
  ]);
  assert.deepEqual(applied, [
    ["live", "effort", "high"],
    ["nextTurn", "delegation", true],
  ]);
  // The shared store holds none of it.
  assert.deepEqual(overrides.list(), []);
  // The audit names the runtime and the field, never a value of a described field.
  assert.deepEqual(
    audit.map((entry) => [entry.action, entry.resourceId, entry.outcome, entry.details]),
    [
      ["setting.updated", "fixture.effort", "success", { runtime: "fixture" }],
      ["setting.updated", "fixture.delegation", "success", { runtime: "fixture" }],
    ],
  );
  // null resets the field to its default.
  const reset = await advanced.saveOwn("fixture", "effort", null);
  assert.equal(valuesOf(reset).effort, null);
  assert.equal(settings.get("fixture", "effort"), null);
  assert.deepEqual(applied.at(-1), ["live", "effort", undefined]);
});

test("a restart field asks first and restarts with the stored value", async () => {
  const restarts = [];
  const { advanced, settings } = setup({
    fixture: {
      restart: async (operation) => {
        restarts.push(settings.get("fixture", "workers")?.value ?? null);
        await operation();
      },
    },
  });
  await assert.rejects(advanced.saveOwn("fixture", "workers", 4), (error) => {
    assert.equal(error.code, "ASSISTANT_RESTART_REQUIRED");
    assert.equal(error.status, 409);
    assert.deepEqual(error.affected.agents, [{ id: "f1", name: "Fix" }]);
    return true;
  });
  assert.equal(settings.get("fixture", "workers"), null);
  const saved = await advanced.saveOwn("fixture", "workers", 4, { confirmed: true });
  assert.deepEqual(restarts, [null]);
  assert.equal(settings.get("fixture", "workers").value, 4);
  assert.equal(valuesOf(saved).workers, 4);
  // A stopped runtime stores the change for its next start, without asking.
  const stopped = setup({ fixture: { running: false } });
  await stopped.advanced.saveOwn("fixture", "workers", 3);
  assert.equal(stopped.settings.get("fixture", "workers").value, 3);
});

test("a failed restart restores the previous own value", async () => {
  const { advanced, settings, audit } = setup({
    fixture: {
      restart: async (operation) => {
        await operation();
        throw Object.assign(Error("start failed"), { status: 503, key: "unavailable" });
      },
    },
  });
  settings.set("fixture", "workers", 3);
  await assert.rejects(advanced.saveOwn("fixture", "workers", 5, { confirmed: true }), {
    status: 503,
  });
  assert.equal(settings.get("fixture", "workers").value, 3);
  assert.deepEqual(
    audit.map((entry) => [entry.action, entry.outcome]),
    [
      ["setting.updated", "success"],
      ["setting.rolled-back", "failure"],
    ],
  );
});

test("the runtime's compiler receives its own values with the desired state", async () => {
  const { advanced, settings } = setup();
  const desired = desiredState({ profiles: [] });
  const compile = () =>
    fixtureCompiler.compile({
      desired,
      settings: ownSettings(fixtureDescriptor, settings),
    });
  // Unset: every field's default.
  assert.deepEqual(compile(), {
    agents: [],
    delegation: false,
    effort: "low",
    workers: 2,
    greeting: "",
  });
  await advanced.saveOwn("fixture", "greeting", "Hello");
  await advanced.saveOwn("fixture", "workers", 6, { confirmed: true });
  assert.deepEqual(compile(), {
    agents: [],
    delegation: false,
    effort: "low",
    workers: 6,
    greeting: "Hello",
  });
});

test("a stored value its descriptor no longer names is ignored, never an error", async () => {
  const { advanced, settings } = setup();
  settings.set("fixture", "retired", "x");
  settings.set("fixture", "workers", 64);
  const listed = await advanced.get();
  assert.deepEqual(valuesOf(listed), {
    delegation: null,
    effort: null,
    workers: null,
    greeting: null,
  });
  // The page still saves over a value today's description refuses.
  await advanced.saveOwn("fixture", "workers", 2, { confirmed: true });
  assert.equal(settings.get("fixture", "workers").value, 2);
});

test("a runtime that describes fields but cannot take them refuses the save", async () => {
  const { advanced, settings } = setup({ fixture: { host: { storeOwn: undefined } } });
  await assert.rejects(advanced.saveOwn("fixture", "effort", "high"), {
    status: 409,
    key: "advancedSettingUnavailable",
  });
  assert.deepEqual(settings.list("fixture"), []);
});

test("every runtime that takes a shared setting hears of its save", async () => {
  const stored = [];
  const taken = [{ id: "thinkingDefault", path: "reasoning", reloadKind: "hot" }];
  const { advanced, overrides } = setup({
    fixture: {
      taken: {
        runtime: "1.0.0",
        list: taken,
        byId: (id) => taken.find((s) => s.id === id),
      },
      host: { stored: (setting) => stored.push(setting.id) },
    },
  });
  await advanced.save("thinkingDefault", "high");
  await advanced.save("runTimeout", 900);
  // Every runtime that takes the setting hears of the save, no other.
  assert.deepEqual(stored, ["thinkingDefault"]);
  assert.deepEqual(
    overrides.list().map((row) => [row.path, row.value]),
    [
      ["agents.defaults.thinkingDefault", "high"],
      ["agents.defaults.timeoutSeconds", 900],
    ],
  );
});

test("no shipped runtime that describes fields lacks the means to take them", () => {
  const supervisor = { status: () => ({ availability: "disabled", version: null }) };
  for (const runtime of advancedRuntimes(supervisor)) {
    assert.equal(typeof runtime.host.status, "function", runtime.id);
    assert.equal(typeof runtime.host.settings, "function", runtime.id);
    const described = runtime.descriptor.surfaces.some(
      (surface) => surface.kind === "described",
    );
    if (described) assert.equal(typeof runtime.host.storeOwn, "function", runtime.id);
  }
});
