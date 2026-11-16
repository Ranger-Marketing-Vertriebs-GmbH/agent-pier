import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  AdvancedConfig,
  advancedValues,
} from "../../server/features/assistants/advanced-config.js";
import { OverrideStore } from "../../server/features/assistants/runtimes/openclaw/openclaw-config/overrides.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";
import { attachHermesFleet } from "../../server/features/assistants/runtimes/hermes/hermes-hosts.js";
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
// Hermes as the page's answer names it, and how its agents take each setting.
const hermesOf = ({ runtimes }) => {
  const { enabled, agents, version, qualified } = runtimes.find(
    (runtime) => runtime.id === "hermes",
  );
  return { enabled, agents, version, qualified };
};

test("the page names which settings Hermes agents take and its approval", async () => {
  const { advanced } = setup();
  const listed = await advanced.get();
  const { settings } = listed;
  // The archived Hermes agent and the OpenClaw agent do not count.
  assert.deepEqual(hermesOf(listed), {
    enabled: true,
    agents: 1,
    version: "0.22.5",
    qualified: true,
  });
  // How Hermes agents take each setting: live, with a restart, or not at all.
  assert.deepEqual(
    Object.fromEntries(settings.map((s) => [s.id, s.runtimes.hermes?.apply ?? null])),
    {
      runTimeout: null,
      thinkingDefault: "hot",
      userTimezone: "restart",
      imageQuality: null,
      imageMaxDimension: null,
      mediaRetention: null,
    },
  );
  // Every setting Hermes takes is available on the approved installation.
  assert.ok(settings.every((s) => s.runtimes.hermes?.available !== false));
  const other = await setup({ hermes: "0.23.0" }).advanced.get();
  // An installation the mapping is not approved for takes none of them.
  assert.ok(other.settings.every((s) => s.runtimes.hermes?.available !== true));
  assert.deepEqual(hermesOf(other), {
    enabled: true,
    agents: 1,
    version: "0.23.0",
    qualified: false,
  });
  const off = await setup({ enabled: false, hermes: null }).advanced.get();
  assert.deepEqual(hermesOf(off), {
    enabled: false,
    agents: 1,
    version: null,
    qualified: true,
  });
});

test("a save of a setting Hermes takes applies every Hermes agent", async () => {
  const { advanced, overrides, applied } = setup();
  await advanced.save("userTimezone", "Asia/Tokyo");
  await settle();
  // Archived agents and OpenClaw agents are not applied.
  assert.deepEqual(applied, ["h1"]);
  assert.deepEqual(advancedValues(overrides), { userTimezone: "Asia/Tokyo" });
  await advanced.save("userTimezone", null);
  await settle();
  assert.deepEqual(applied, ["h1", "h1"]);
  assert.deepEqual(advancedValues(overrides), {});
});

test("a save of an OpenClaw-only setting leaves Hermes agents alone", async () => {
  const { advanced, overrides, applied } = setup();
  await advanced.save("runTimeout", 900);
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
