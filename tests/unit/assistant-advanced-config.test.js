import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AdvancedConfig } from "../../server/features/assistants/advanced-config.js";
import { OverrideStore } from "../../server/features/assistants/openclaw-config/overrides.js";
import {
  advancedSettings,
  advancedSettingsRuntime,
} from "../../server/features/assistants/openclaw-config/advanced-settings.js";
import { migrateAssistants } from "../../server/features/assistants/assistant-schema.js";

const timeout = "agents.defaults.timeoutSeconds";

function fakeGateway({ kinds = {}, refuse = false } = {}) {
  const gateway = {
    config: { agents: { defaults: { workspace: "/w" } } },
    hash: 1,
    calls: [],
    ready: true,
    async call(method, params) {
      gateway.calls.push([method, params]);
      if (method === "config.get")
        return { config: structuredClone(gateway.config), hash: `h${gateway.hash}` };
      if (method === "config.schema.lookup") {
        const kind = Object.hasOwn(kinds, params.path) ? kinds[params.path] : "hot";
        if (kind === undefined)
          throw Object.assign(Error("unknown"), {
            answered: true,
            code: "INVALID_REQUEST",
          });
        return { path: params.path, reloadKind: kind };
      }
      if (method === "config.patch") {
        if (refuse)
          throw Object.assign(Error("invalid config /secret/path"), {
            answered: true,
            code: "INVALID_REQUEST",
          });
        merge(gateway.config, JSON.parse(params.raw));
        gateway.hash++;
        return {};
      }
      throw Error(`unexpected ${method}`);
    },
  };
  return gateway;
}

function merge(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete target[key];
    else if (typeof value === "object") merge((target[key] ??= {}), value);
    else target[key] = value;
  }
}

function setup({
  availability = "ready",
  version = advancedSettingsRuntime,
  gateway = fakeGateway(),
  restartGateway,
  paths,
} = {}) {
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  const overrides = new OverrideStore(db);
  const audit = [];
  const admitted = [];
  const runtime = {
    status: () => ({ availability, version }),
    client: availability === "ready" ? gateway : null,
    paths,
  };
  const synchronization = {
    restarts: 0,
    async restartGateway(operation) {
      synchronization.restarts++;
      if (restartGateway) return restartGateway(operation);
      return operation();
    },
  };
  const advanced = new AdvancedConfig({
    assistants: {
      runtime,
      admit: async (operation) => {
        admitted.push(true);
        return operation();
      },
    },
    overrides,
    synchronization,
    usage: () => ({ agents: [{ id: "a", name: "Home" }], teamMembers: 0 }),
    audit: { append: (entry) => audit.push(entry) },
  });
  return { advanced, overrides, gateway, audit, admitted, synchronization };
}

test("a stopped Gateway lists every allowed setting with the qualified facts", async () => {
  const { advanced, overrides } = setup({ availability: "disabled", version: null });
  overrides.set(timeout, 900);
  const { gateway, settings } = await advanced.get();
  assert.deepEqual(gateway, { running: false, version: null, qualified: true });
  assert.deepEqual(
    settings.map((s) => s.path),
    advancedSettings.map((s) => s.path),
  );
  const run = settings.find((s) => s.path === timeout);
  assert.equal(run.override, 900);
  assert.equal(run.current, null);
  assert.equal(run.reloadKind, "hot");
  assert.equal(run.available, true);
  assert.equal(run.minimum, 300);
  assert.equal(run.fallback, 172800);
  assert.deepEqual(settings.find((s) => s.id === "imageQuality").options, [
    "auto",
    "efficient",
    "balanced",
    "high",
  ]);
});

test("a stopped Gateway stores the change for its next start", async () => {
  const { advanced, overrides, audit } = setup({ availability: "disabled" });
  await advanced.save(timeout, 900);
  assert.equal(overrides.get(timeout).value, 900);
  await advanced.save(timeout, null);
  assert.equal(overrides.get(timeout), null);
  assert.deepEqual(
    audit.map((entry) => entry.details),
    [
      { path: timeout, from: null, to: 900 },
      { path: timeout, from: 900, to: null },
    ],
  );
});

test("invalid paths and values are refused before anything is stored", async () => {
  const { advanced, overrides, gateway } = setup();
  for (const [target, value] of [
    ["gateway.auth.token", "x"],
    ["models.providers.p.baseUrl", "http://x"],
    [timeout, 10],
    [timeout, "900"],
    ["agents.defaults.thinkingDefault", "loud"],
  ])
    await assert.rejects(advanced.save(target, value), { status: 400 }, target);
  assert.deepEqual(overrides.list(), []);
  assert.equal(
    gateway.calls.some(([method]) => method === "config.patch"),
    false,
  );
});

test("a hot setting applies live and a reset removes it from the Gateway", async () => {
  const { advanced, overrides, gateway, admitted } = setup();
  const result = await advanced.save(timeout, 900);
  assert.equal(gateway.config.agents.defaults.timeoutSeconds, 900);
  assert.equal(overrides.get(timeout).value, 900);
  assert.equal(result.settings.find((s) => s.path === timeout).current, 900);
  assert.ok(admitted.length);
  await advanced.save("attachments.ttlHours", 72);
  await advanced.save("attachments.ttlHours", null);
  assert.equal(gateway.config.attachments?.ttlHours, undefined);
  assert.equal(overrides.get("attachments.ttlHours"), null);
  const patches = gateway.calls.filter(([m]) => m === "config.patch");
  assert.deepEqual(JSON.parse(patches.at(-1)[1].raw), {
    attachments: { ttlHours: null },
  });
});

test("a value the Gateway refuses is not stored and leaks no detail", async () => {
  const { advanced, overrides } = setup({ gateway: fakeGateway({ refuse: true }) });
  await assert.rejects(advanced.save(timeout, 900), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.message.includes("/secret/path"), false);
    return true;
  });
  assert.equal(overrides.get(timeout), null);
});

test("a restart setting asks first and restarts with the stored value", async () => {
  const gateway = fakeGateway({ kinds: { [timeout]: "restart" } });
  const { advanced, overrides, synchronization } = setup({ gateway });
  await assert.rejects(advanced.save(timeout, 900), (error) => {
    assert.equal(error.code, "ASSISTANT_RESTART_REQUIRED");
    assert.equal(error.status, 409);
    assert.deepEqual(error.affected.agents, [{ id: "a", name: "Home" }]);
    return true;
  });
  assert.equal(overrides.get(timeout), null);
  const result = await advanced.save(timeout, 900, { confirmed: true });
  assert.equal(synchronization.restarts, 1);
  assert.equal(overrides.get(timeout).value, 900);
  assert.equal(result.settings.find((s) => s.path === timeout).reloadKind, "restart");
});

test("a failed restart restores the previous override", async () => {
  const gateway = fakeGateway({ kinds: { [timeout]: "restart" } });
  const { advanced, overrides, audit } = setup({
    gateway,
    async restartGateway(operation) {
      await operation();
      throw Object.assign(Error("start failed"), { status: 503, key: "unavailable" });
    },
  });
  overrides.set(timeout, 700);
  await assert.rejects(advanced.save(timeout, 900, { confirmed: true }), {
    status: 503,
  });
  assert.equal(overrides.get(timeout).value, 700);
  // The audit records the change and then that it was undone.
  assert.deepEqual(
    audit.map((entry) => [entry.outcome, entry.details.from, entry.details.to]),
    [
      ["success", 700, 900],
      ["failure", 900, 700],
    ],
  );
});

test("a path the running Gateway does not know is shown but not editable", async () => {
  const gateway = fakeGateway({ kinds: { [timeout]: undefined } });
  const { advanced } = setup({ gateway });
  const { settings } = await advanced.get();
  assert.equal(settings.find((s) => s.path === timeout).available, false);
  await assert.rejects(advanced.save(timeout, 900), {
    status: 409,
    key: "advancedSettingUnavailable",
  });
  // The lookups are read once per runtime version.
  await advanced.get();
  const lookups = gateway.calls.filter(([m]) => m === "config.schema.lookup");
  assert.equal(lookups.length, advancedSettings.length);
});

test("another runtime version or a Gateway in transition refuses changes", async () => {
  const other = setup({ version: "2026.9.8" });
  const listed = await other.advanced.get();
  assert.equal(listed.gateway.qualified, false);
  assert.ok(listed.settings.every((s) => !s.available));
  await assert.rejects(other.advanced.save(timeout, 900), {
    key: "advancedSettingUnavailable",
  });
  const starting = setup({ availability: "starting" });
  await assert.rejects(starting.advanced.save(timeout, 900), {
    status: 409,
    key: "active",
  });
  assert.deepEqual(starting.overrides.list(), []);
});

test("a stopped Gateway takes the installed runtime's version into account", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "advanced-installed-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "runtime.json"),
    JSON.stringify({ version: "2026.9.8" }),
  );
  const rolledBack = setup({ availability: "disabled", version: null, paths: { root } });
  const listed = await rolledBack.advanced.get();
  assert.deepEqual(listed.gateway, {
    running: false,
    version: "2026.9.8",
    qualified: false,
  });
  assert.ok(listed.settings.every((s) => !s.available));
  await assert.rejects(rolledBack.advanced.save(timeout, 900), {
    key: "advancedSettingUnavailable",
  });
  fs.writeFileSync(
    path.join(root, "runtime.json"),
    JSON.stringify({ version: advancedSettingsRuntime }),
  );
  const current = setup({ availability: "disabled", version: null, paths: { root } });
  assert.equal((await current.advanced.get()).gateway.qualified, true);
});

test("a rollback while the Gateway is stopped follows the installed runtime", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "advanced-rollback-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "runtime.json"),
    JSON.stringify({ version: "2026.9.8" }),
  );
  // The last start ran the qualified runtime; the rollback selected 2026.9.8 since.
  const stopped = setup({
    availability: "disabled",
    version: advancedSettingsRuntime,
    paths: { root },
  });
  const listed = await stopped.advanced.get();
  assert.equal(listed.gateway.version, "2026.9.8");
  assert.equal(listed.gateway.qualified, false);
  assert.ok(listed.settings.every((s) => !s.available));
  await assert.rejects(stopped.advanced.save(timeout, 900), {
    key: "advancedSettingUnavailable",
  });
  assert.deepEqual(stopped.overrides.list(), []);
  // A ready Gateway reports what it actually runs.
  const ready = setup({ version: advancedSettingsRuntime, paths: { root } });
  assert.equal((await ready.advanced.get()).gateway.qualified, true);
});
