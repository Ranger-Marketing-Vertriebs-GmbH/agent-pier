import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AdvancedConfig,
  advancedValues,
} from "../../server/features/assistants/advanced-config.js";
import { OverrideStore } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/overrides.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/runtime-for.js";
import { HermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-fleet.js";

// The advanced settings for all agents as they reach Hermes agents
// (hermes-config/advanced.js): which settings Hermes takes, its approval per version,
// and the applies a save starts. OpenClaw's side: assistant-advanced-config.test.js.

function setup({ hermes = "0.22.5", enabled = true } = {}) {
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  const overrides = new OverrideStore(db);
  const runtime = { status: () => ({ availability: "disabled", version: null }) };
  attachHermesFleet(
    runtime,
    new HermesFleet({ dataDir: null, available: () => enabled, version: () => hermes }),
  );
  const applied = [];
  const profiles = [
    { id: "h1", runtime: "hermes", runtimeAgentId: "ap-h1" },
    { id: "h2", runtime: "hermes", runtimeAgentId: "ap-h2", archivedAt: "2026-11-01" },
    { id: "o1", runtimeAgentId: "ap-o1" },
  ];
  const advanced = new AdvancedConfig({
    assistants: {
      runtime,
      admit: async (operation) => operation(),
      store: { listAssistants: () => profiles },
      config: { apply: async (id) => applied.push(id) },
    },
    overrides,
    synchronization: { restartGateway: async (operation) => operation() },
    audit: { append: () => {} },
  });
  return { advanced, overrides, applied };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the page names which settings Hermes agents take and its approval", async () => {
  const { advanced } = setup();
  const { hermes, settings } = await advanced.get();
  assert.deepEqual(hermes, { enabled: true, version: "0.22.5", qualified: true });
  assert.deepEqual(
    settings.filter((s) => s.hermes).map((s) => s.id),
    ["thinkingDefault", "userTimezone"],
  );
  const other = await setup({ hermes: "0.23.0" }).advanced.get();
  assert.deepEqual(other.hermes, { enabled: true, version: "0.23.0", qualified: false });
  const off = await setup({ enabled: false, hermes: null }).advanced.get();
  assert.deepEqual(off.hermes, { enabled: false, version: null, qualified: true });
});

test("a save of a setting Hermes takes applies every Hermes agent", async () => {
  const { advanced, overrides, applied } = setup();
  await advanced.save("agents.defaults.userTimezone", "Asia/Tokyo");
  await settle();
  // Archived agents and OpenClaw agents are not applied.
  assert.deepEqual(applied, ["h1"]);
  assert.deepEqual(advancedValues(overrides), { userTimezone: "Asia/Tokyo" });
  await advanced.save("agents.defaults.userTimezone", null);
  await settle();
  assert.deepEqual(applied, ["h1", "h1"]);
  assert.deepEqual(advancedValues(overrides), {});
});

test("a save of an OpenClaw-only setting leaves Hermes agents alone", async () => {
  const { advanced, overrides, applied } = setup();
  await advanced.save("agents.defaults.timeoutSeconds", 900);
  await settle();
  assert.deepEqual(applied, []);
  // Stored for OpenClaw; Hermes compiles only the settings it maps.
  assert.deepEqual(advancedValues(overrides), { runTimeout: 900 });
});

test("an unreadable store leaves the Hermes keys as they are", () => {
  assert.equal(
    advancedValues({
      list: () => {
        throw Error("closed");
      },
    }),
    undefined,
  );
});
