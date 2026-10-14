import test from "node:test";
import assert from "node:assert/strict";
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
} = {}) {
  const db = new DatabaseSync(":memory:");
  migrateAssistants(db);
  const overrides = new OverrideStore(db);
  const audit = [];
  const admitted = [];
  const runtime = {
    status: () => ({ availability, version }),
    client: availability === "ready" ? gateway : null,
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
  assert.equal(run.minimum, 60);
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
  await advanced.save("attachments.ttlHours", 24);
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
  const { advanced, overrides } = setup({
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
