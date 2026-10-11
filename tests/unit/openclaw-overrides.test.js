import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  validateOverride,
  applyOverrides,
  OverrideStore,
} from "../../server/features/assistants/openclaw-config/overrides.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";

test("overrides cannot reach locked paths, their parents or prototype keys", () => {
  for (const target of [
    "gateway.auth.token",
    "agents",
    "",
    "tools.allow",
    "__proto__.polluted",
    "models.constructor.x",
    "models..x",
  ])
    assert.throws(() => validateOverride(target, 1), { status: 400 });
  assert.deepEqual(validateOverride("models.providers.p.timeout", 5), {
    path: "models.providers.p.timeout",
    value: 5,
  });
});

test("overrides merge below the locked core", () => {
  const config = applyOverrides({ models: { providers: { p: { a: 1 } } } }, [
    { path: "models.providers.p.timeout", value: 5 },
  ]);
  assert.deepEqual(config.models.providers.p, { a: 1, timeout: 5 });
  assert.equal(Object.prototype.polluted, undefined);
});

test("stored overrides keep a revision and can be removed", () => {
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  const store = new OverrideStore(db);
  store.set("models.providers.p.timeout", 5);
  store.set("models.providers.p.timeout", 7);
  assert.deepEqual(store.list(), [
    { path: "models.providers.p.timeout", value: 7, revision: 2 },
  ]);
  store.remove("models.providers.p.timeout");
  assert.deepEqual(store.list(), []);
});

test("compiling twice from the same inputs is deterministic and does not mutate them", async () => {
  const { compileOpenClawConfig } =
    await import("../../server/features/assistants/runtime-config.js");
  const { runtimePaths } =
    await import("../../server/features/assistants/runtime-paths.js");
  const paths = runtimePaths("/tmp/compile-pure");
  const existing = { agents: { defaults: {} }, models: { providers: {} } };
  const frozen = structuredClone(existing);
  const input = { existing, paths, port: 1, token: "t", overrides: [] };
  assert.deepEqual(compileOpenClawConfig(input), compileOpenClawConfig(input));
  assert.deepEqual(existing, frozen);
});

test("a launch writes stored overrides but never over the core", async (t) => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { runtimePaths } =
    await import("../../server/features/assistants/runtime-paths.js");
  const { prepareRuntimeConfig } =
    await import("../../server/features/assistants/runtime-config.js");
  const { readJSON } = await import("../../server/lib/storage.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overrides-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234, undefined, {
    overrides: [{ path: "agents.defaults.timeoutSeconds", value: 600 }],
  });
  const config = readJSON(paths.config);
  assert.equal(config.agents.defaults.timeoutSeconds, 600);
  assert.equal(config.gateway.controlUi.enabled, false);
});
