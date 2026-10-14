import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  validateOverride,
  applyOverrides,
  overridesFor,
  OverrideStore,
} from "../../server/features/assistants/openclaw-config/overrides.js";
import {
  advancedSettings,
  advancedSettingsRuntime,
  settingBounds,
  validSettingValue,
} from "../../server/features/assistants/openclaw-config/advanced-settings.js";
import { isLockedPath } from "../../server/features/assistants/openclaw-config/locked-core.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import {
  compileOpenClawConfig,
  prepareRuntimeConfig,
} from "../../server/features/assistants/runtime-config.js";
import { readJSON } from "../../server/lib/storage.js";

function database() {
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  return db;
}

function tempPaths(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return runtimePaths(dir);
}

test("the allow list is reviewed against every OpenClaw update", () => {
  // Bumping the bundled OpenClaw fails here until the list was compared with the new
  // config.schema (the advanced settings contract checks the live schema). The
  // version comes from the runtime lock that installations are provisioned from.
  const lock = JSON.parse(
    fs.readFileSync(
      new URL(
        "../../server/features/assistants/runtime-lock/package-lock.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.equal(advancedSettingsRuntime, lock.packages["node_modules/openclaw"].version);
  assert.equal(advancedSettingsRuntime, runtimeManifest.version);
  const ids = new Set(advancedSettings.map((s) => s.id));
  assert.equal(ids.size, advancedSettings.length);
  for (const setting of advancedSettings) {
    assert.equal(isLockedPath(setting.path), false, setting.path);
    assert.ok(["hot", "none", "restart"].includes(setting.reloadKind), setting.path);
    const bounds = settingBounds(setting);
    // AgentPier's limits only ever narrow the upstream range.
    if (setting.limits) {
      assert.ok(bounds.minimum >= (setting.schema.minimum ?? -Infinity));
      assert.ok(bounds.maximum <= (setting.schema.maximum ?? Infinity));
    }
    if (setting.fallback !== null)
      assert.equal(validSettingValue(setting, setting.fallback), true, setting.path);
  }
});

test("only allow-listed paths with a valid value are overrides", () => {
  for (const target of [
    "gateway.auth.token",
    "agents",
    "agents.defaults",
    "",
    "tools.allow",
    "__proto__.polluted",
    "models.constructor.x",
    "models..x",
    // The former deny list let these through.
    "models.providers.p.timeout",
    "auth.profiles.main",
    "hooks.gmail.account",
    "acp.enabled",
    "security.installPolicy",
    "skills.load.extraDirs",
    "agents.defaults.sandbox.mode",
    "agents.defaults.model.primary",
    // A key a future OpenClaw might add.
    "agents.defaults.somethingNew",
  ])
    assert.throws(() => validateOverride(target, 1), { status: 400 }, target);
  for (const [target, value] of [
    ["agents.defaults.timeoutSeconds", "600"],
    ["agents.defaults.timeoutSeconds", 600.5],
    ["agents.defaults.timeoutSeconds", 0],
    ["agents.defaults.timeoutSeconds", 299],
    ["agents.defaults.imageMaxDimensionPx", 2001],
    ["attachments.ttlHours", 47],
    ["agents.defaults.thinkingDefault", "extreme"],
    ["agents.defaults.userTimezone", "+02:00"],
    ["agents.defaults.userTimezone", "Mars/Olympus"],
    ["agents.defaults.imageQuality", { level: "high" }],
    ["attachments.ttlHours", 169],
    ["attachments.ttlHours", null],
    ["attachments.ttlHours", JSON.parse('{"__proto__":{"polluted":1}}')],
  ])
    assert.throws(() => validateOverride(target, value), { status: 400 }, target);
  assert.deepEqual(validateOverride("agents.defaults.timeoutSeconds", 600), {
    path: "agents.defaults.timeoutSeconds",
    value: 600,
  });
  assert.deepEqual(validateOverride("agents.defaults.userTimezone", "Europe/Berlin"), {
    path: "agents.defaults.userTimezone",
    value: "Europe/Berlin",
  });
  assert.equal(Object.prototype.polluted, undefined);
});

test("an unset override leaves no trace while sibling keys survive", () => {
  const existing = {
    agents: {
      defaults: {
        workspace: "/w",
        compaction: { mode: "safeguard" },
        timeoutSeconds: 900,
        imageQuality: "high",
      },
    },
    attachments: { ttlHours: 5 },
    models: { providers: { p: { a: 1 } } },
  };
  const config = applyOverrides(existing, [
    { path: "agents.defaults.imageQuality", value: "efficient" },
  ]);
  assert.deepEqual(config.agents.defaults, {
    workspace: "/w",
    compaction: { mode: "safeguard" },
    imageQuality: "efficient",
  });
  assert.equal("attachments" in config, false);
  assert.deepEqual(config.models, existing.models);
  assert.equal(existing.agents.defaults.timeoutSeconds, 900);
});

test("a removed override is gone after the next start", (t) => {
  const paths = tempPaths(t, "overrides-removed-");
  const store = new OverrideStore(database());
  store.set("agents.defaults.timeoutSeconds", 600);
  store.set("attachments.ttlHours", 72);
  prepareRuntimeConfig(paths, 1234, undefined, { overrides: store.list() });
  assert.equal(readJSON(paths.config).agents.defaults.timeoutSeconds, 600);
  store.remove("agents.defaults.timeoutSeconds");
  store.remove("attachments.ttlHours");
  prepareRuntimeConfig(paths, 1234, undefined, { overrides: store.list() });
  const config = readJSON(paths.config);
  assert.equal("timeoutSeconds" in config.agents.defaults, false);
  assert.equal("attachments" in config, false);
});

test("stored overrides keep a revision and can be removed", () => {
  const store = new OverrideStore(database());
  store.set("agents.defaults.timeoutSeconds", 600);
  store.set("agents.defaults.timeoutSeconds", 700);
  assert.deepEqual(store.list(), [
    { path: "agents.defaults.timeoutSeconds", value: 700, revision: 2 },
  ]);
  assert.deepEqual(store.get("agents.defaults.timeoutSeconds").value, 700);
  store.remove("agents.defaults.timeoutSeconds");
  assert.deepEqual(store.list(), []);
  assert.equal(store.get("agents.defaults.timeoutSeconds"), null);
});

test("compiling twice from the same inputs is deterministic and does not mutate them", () => {
  const paths = runtimePaths("/tmp/compile-pure");
  const existing = { agents: { defaults: { timeoutSeconds: 5 } }, models: {} };
  const frozen = structuredClone(existing);
  const input = { existing, paths, port: 1, token: "t", overrides: [] };
  assert.deepEqual(compileOpenClawConfig(input), compileOpenClawConfig(input));
  assert.deepEqual(existing, frozen);
});

test("a launch writes stored overrides but never over the core", (t) => {
  const paths = tempPaths(t, "overrides-");
  prepareRuntimeConfig(paths, 1234, undefined, {
    overrides: [{ path: "agents.defaults.timeoutSeconds", value: 600 }],
  });
  const config = readJSON(paths.config);
  assert.equal(config.agents.defaults.timeoutSeconds, 600);
  assert.equal(config.gateway.controlUi.enabled, false);
});

test("hostile stored rows over an existing file are skipped and logged by path", (t) => {
  const paths = tempPaths(t, "overrides-skip-");
  prepareRuntimeConfig(paths, 1234);
  const before = readJSON(paths.config);
  const db = database();
  const skipped = [];
  const store = new OverrideStore(db, { onSkip: (p) => skipped.push(p) });
  store.set("agents.defaults.timeoutSeconds", 600);
  const insert = db.prepare(
    "INSERT INTO openclaw_overrides (path, value, revision) VALUES (?, ?, 1)",
  );
  insert.run("models.corrupt", "{not json");
  insert.run("gateway.auth.token", JSON.stringify("secret-value"));
  insert.run("models.providers.p.baseUrl", JSON.stringify("http://evil"));
  insert.run("attachments.ttlHours", '{"__proto__":{"polluted":true}}');
  insert.run("agents.defaults.imageQuality", JSON.stringify("ultra"));
  const rows = store.list();
  assert.deepEqual(rows, [
    { path: "agents.defaults.timeoutSeconds", value: 600, revision: 1 },
  ]);
  assert.deepEqual(skipped.sort(), [
    "agents.defaults.imageQuality",
    "attachments.ttlHours",
    "gateway.auth.token",
    "models.corrupt",
    "models.providers.p.baseUrl",
  ]);
  assert.ok(!JSON.stringify(skipped).includes("secret-value"));
  prepareRuntimeConfig(paths, 1234, undefined, { overrides: rows });
  const config = readJSON(paths.config);
  assert.equal(config.agents.defaults.timeoutSeconds, 600);
  assert.equal(config.gateway.auth.token, before.gateway.auth.token);
  assert.deepEqual(config.models, before.models);
  assert.equal("attachments" in config, false);
  assert.equal(Object.prototype.polluted, undefined);
});

test("overrides apply only to the runtime the allow list was qualified for", () => {
  const store = new OverrideStore(database());
  store.set("agents.defaults.timeoutSeconds", 600);
  const warnings = [];
  const warn = (message) => warnings.push(message);
  assert.equal(overridesFor(store, advancedSettingsRuntime, { warn }).length, 1);
  assert.deepEqual(overridesFor(store, "2026.9.8", { warn }), []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /2026\.9\.8/);
  assert.ok(!warnings[0].includes("600"));
});
