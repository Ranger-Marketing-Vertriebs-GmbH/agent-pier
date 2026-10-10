import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { applicationFixture } from "../helpers/application.js";
import { ProviderConnections } from "../../server/features/providers/provider-connections.js";
import {
  assistantServiceNames,
  createAssistantFeature,
} from "../../server/application/assistants.js";
import { writeAssistantFeature } from "../../server/features/assistants/assistant-feature.js";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";

const resources = () =>
  process
    .getActiveResourcesInfo()
    .filter((name) => name !== "TTYWrap")
    .sort()
    .join(",");
async function settlesTo(expected) {
  for (let attempt = 0; attempt < 100 && resources() !== expected; attempt++)
    await delay(20);
  assert.equal(resources(), expected);
}
function isolatedServices(t) {
  const root = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "assistant-dormant-")),
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { mode: 0o700 });
  return {
    dataDir,
    services: {
      config: { dataDir },
      providerConnections: new ProviderConnections({ dataDir }),
    },
  };
}

test("a dormant feature creates no assistant storage, timers or services", async (t) => {
  const { dataDir, services } = isolatedServices(t);
  const before = resources();
  const feature = createAssistantFeature(services);
  await feature.connect();
  feature.start();
  assert.equal(resources(), before);
  assert.deepEqual(feature.state(), { enabled: false, error: null });
  for (const name of assistantServiceNames) assert.equal(services[name], null, name);
  for (const name of ["assistants", "speech"])
    assert.equal(fs.existsSync(path.join(dataDir, name)), false, name);
  await feature.close();
});

test("enabling starts assistant services lazily and disabling releases every handle", async (t) => {
  const { dataDir, services } = isolatedServices(t);
  const before = resources();
  const feature = createAssistantFeature(services);
  await feature.connect();
  feature.start();
  assert.deepEqual(await feature.enable(), { enabled: true, error: null });
  assert.ok(services.assistants && services.assistantWorkflows);
  const { assistants, assistantChannels, assistantWorkflows, assistantTeams } = services;
  // Unreferenced timers are invisible to getActiveResourcesInfo, so check them directly.
  const timers = {
    channels: assistantChannels.timer,
    workflows: assistantWorkflows.timer,
    reconcile: assistants.poll,
    teams: assistantTeams.poll,
  };
  for (const [name, timer] of Object.entries(timers))
    assert.equal(timer?._destroyed, false, `${name} timer runs once enabled`);
  assert.ok(fs.existsSync(path.join(dataDir, "assistants", "assistants.sqlite")));
  assert.deepEqual(await feature.disable(), { enabled: false, error: null });
  for (const name of assistantServiceNames) assert.equal(services[name], null, name);
  assert.equal(assistants.closed, true);
  assert.equal(assistantChannels.closed, true);
  assert.equal(assistantWorkflows.closed, true);
  assert.equal(assistants.store.db.isOpen, false);
  assert.equal(assistantChannels.store.db.isOpen, false);
  for (const [name, timer] of Object.entries(timers))
    assert.equal(timer._destroyed, true, `${name} timer stops once disabled`);
  await settlesTo(before);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dataDir, "assistant-feature.json"))),
    {
      enabled: false,
    },
  );
});

test("a dormant application rejects assistant routes and toggles the feature without restart", async (t) => {
  const f = await applicationFixture(t);
  const health = await f.request("/api/health");
  assert.equal(health.status, 200);
  assert.deepEqual(await (await f.request("/api/assistant-feature")).json(), {
    enabled: false,
    error: null,
  });
  for (const endpoint of ["/api/assistants", "/api/assistant-events"]) {
    const response = await f.request(endpoint);
    assert.equal(response.status, 404, endpoint);
    assert.equal((await response.json()).code, "ASSISTANTS_DISABLED", endpoint);
  }
  assert.equal(fs.existsSync(path.join(f.dataDir, "assistants")), false);
  assert.equal(f.application.assistants, null);

  const invalid = await f.request("/api/assistant-feature", {
    method: "PUT",
    body: { enabled: "yes" },
  });
  assert.equal(invalid.status, 400);
  const enabled = await f.request("/api/assistant-feature", {
    method: "PUT",
    body: { enabled: true },
  });
  assert.equal(enabled.status, 200);
  assert.deepEqual(await enabled.json(), { enabled: true, error: null });
  const listed = await f.request("/api/assistants");
  assert.equal(listed.status, 200);
  assert.deepEqual((await listed.json()).assistants, []);
  assert.ok(f.application.assistantChannels.timer);

  const disabled = await f.request("/api/assistant-feature", {
    method: "PUT",
    body: { enabled: false },
  });
  assert.deepEqual(await disabled.json(), { enabled: false, error: null });
  assert.equal(f.application.assistants, null);
  assert.equal((await f.request("/api/assistants")).status, 404);
});

test("an install with existing assistants starts with assistants enabled", async (t) => {
  const f = await applicationFixture(t, {
    prepareDataDir(dataDir) {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const store = new AssistantStore({ dataDir });
      store.db
        .prepare("INSERT INTO assistants VALUES (?,?,?)")
        .run("existing", 1, JSON.stringify({ id: "existing", name: "Home" }));
      store.close();
    },
  });
  assert.deepEqual(await (await f.request("/api/assistant-feature")).json(), {
    enabled: true,
    error: null,
  });
  assert.equal((await f.request("/api/assistants")).status, 200);
  assert.ok(fs.existsSync(path.join(f.dataDir, "assistant-feature.json")));
});

for (const enabled of [true, false])
  test(`unsafe assistant storage never blocks startup (feature ${enabled ? "on" : "off"})`, async (t) => {
    let target;
    const f = await applicationFixture(t, {
      prepareDataDir(dataDir) {
        target = path.join(path.dirname(dataDir), "foreign-assistants");
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        fs.mkdirSync(target, { mode: 0o700 });
        fs.symlinkSync(target, path.join(dataDir, "assistants"));
        writeAssistantFeature(dataDir, { enabled });
      },
    });
    assert.equal((await f.request("/api/health")).status, 200);
    const state = await (await f.request("/api/assistant-feature")).json();
    assert.deepEqual(state, { enabled, error: "ASSISTANT_STORAGE_UNSAFE" });
    assert.ok(!JSON.stringify(state).includes(target));
    const response = await f.request("/api/assistants");
    assert.equal(response.status, enabled ? 503 : 404);
    assert.equal(
      (await response.json()).code,
      enabled ? "ASSISTANT_STORAGE_UNSAFE" : "ASSISTANTS_DISABLED",
    );
    assert.deepEqual(fs.readdirSync(target), []);
  });

test("disabling waits for a running update or provider change", async (t) => {
  const { dataDir, services } = isolatedServices(t);
  const feature = createAssistantFeature(services);
  await feature.connect();
  feature.start();
  await feature.enable();
  t.after(() => feature.close());
  const status = services.assistantUpdates.status.bind(services.assistantUpdates);
  services.assistantUpdates.status = () => ({ ...status(), busy: true });
  await assert.rejects(feature.disable(), { status: 409 });
  services.assistantUpdates.status = status;
  services.assistantProviderSynchronization.changing = true;
  await assert.rejects(feature.disable(), { status: 409 });
  assert.equal(feature.enabled, true);
  assert.ok(services.assistants);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataDir, "assistant-feature.json"))).enabled,
    true,
  );
  services.assistantProviderSynchronization.changing = false;
  assert.deepEqual(await feature.disable(), { enabled: false, error: null });
});
