import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";
import { workflowFixture } from "../helpers/assistant-workflow-fixture.js";
import {
  AssistantMaintenance,
  needsAssistantMaintenance,
} from "../../server/features/assistants/assistant-maintenance.js";
test("maintenance joins workers, blocks admissions, reports unresolved effects and resumes deliberately", async (t) => {
  const f = await workflowFixture(t);
  let paused = 0,
    resumed = 0;
  f.service.pause = async () => {
    paused++;
  };
  f.service.resume = () => {
    resumed++;
  };
  f.assistants.locks = new Map();
  f.assistants.reconcile = async () => {};
  const s = {
    ...f.services,
    assistantRuntime: f.assistants.runtime,
    assistantTeams: { store: { members: () => [], list: () => [] }, scheduler: {} },
    assistantReminders: { hasRunning: async () => false, webhook: { jobs: new Set() } },
  };
  const m = new AssistantMaintenance(s);
  await m.enter();
  assert.equal(f.assistants.maintenance, true);
  assert.equal(paused, 1);
  assert.deepEqual(await m.blockers(), []);
  await f.invocation();
  assert.ok((await m.blockers()).includes("ASSISTANT_WORK"));
  await m.quiesce();
  assert.equal(f.assistants.maintenance, true);
  await m.leave();
  assert.equal(f.assistants.maintenance, false);
  assert.equal(resumed, 1);
});

function cronFixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-maintenance-cron-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  writePrivate(paths.config, { cron: { enabled: true, webhookToken: "private" } });
  let resumed = 0;
  const services = {
    assistants: { locks: new Map(), reconcile: async () => {} },
    assistantChannels: {
      pause: async () => {},
      resume: () => {
        resumed++;
      },
    },
    assistantRuntime: {
      paths,
      client: {
        ready: true,
        call: async (method, input) => {
          if (method === "config.get")
            return { hash: "hash", config: readJSON(paths.config) };
          if (method === "config.patch") {
            assert.deepEqual(Object.keys(JSON.parse(input.raw)), ["cron"]);
            const config = readJSON(paths.config);
            config.cron.enabled = JSON.parse(input.raw).cron.enabled;
            writePrivate(paths.config, config);
            return {};
          }
          if (method === "cron.status")
            return { enabled: readJSON(paths.config).cron.enabled };
          assert.fail(method);
        },
      },
    },
  };
  return { paths, services, resumed: () => resumed };
}

test("maintenance persists scheduling intent, pauses cron, and restores it after recovery", async (t) => {
  const f = cronFixture(t);
  await new AssistantMaintenance(f.services).enter();
  assert.equal(readJSON(f.paths.config).cron.enabled, false);
  assert.equal(f.services.assistants.maintenanceEpoch, 1);
  const recovered = new AssistantMaintenance(f.services);
  await recovered.enter();
  await recovered.leave();
  assert.equal(readJSON(f.paths.config).cron.enabled, true);
  assert.equal(readJSON(f.paths.config).cron.webhookToken, "private");
  assert.equal(f.services.assistants.maintenance, false);
  assert.equal(f.resumed(), 1);
  assert.equal(fs.existsSync(path.join(f.paths.root, "runtime-maintenance.json")), false);
});

test("failed scheduler restoration cannot resume admissions or channel work", async (t) => {
  const f = cronFixture(t);
  const maintenance = new AssistantMaintenance(f.services);
  await maintenance.enter();
  const call = f.services.assistantRuntime.client.call;
  f.services.assistantRuntime.client.call = async (method, input) => {
    if (method === "config.patch") throw Error("unavailable");
    return call(method, input);
  };
  await assert.rejects(maintenance.leave());
  assert.equal(f.services.assistants.maintenance, true);
  assert.equal(f.resumed(), 0);
  assert.equal(fs.existsSync(path.join(f.paths.root, "runtime-maintenance.json")), true);
});

test("startup gates corrupt update journals and orphaned provider maintenance", (t) => {
  const f = cronFixture(t);
  assert.equal(needsAssistantMaintenance(f.paths), false);
  writePrivate(path.join(f.paths.root, "runtime-maintenance.json"), {
    cronEnabled: true,
    wasRunning: true,
  });
  assert.equal(needsAssistantMaintenance(f.paths), true);
  fs.rmSync(path.join(f.paths.root, "runtime-maintenance.json"));
  fs.writeFileSync(path.join(f.paths.root, "update.json"), "{truncated");
  assert.equal(needsAssistantMaintenance(f.paths), true);
});

test("active provider maintenance cannot masquerade as orphan recovery", async (t) => {
  const f = cronFixture(t);
  f.services.assistantProviderSynchronization = {
    changing: true,
    pauseBlocked: async () => {},
  };
  const maintenance = new AssistantMaintenance(f.services);
  await maintenance.enter();
  assert.equal(maintenance.recoveryState(), null);
  f.services.assistantProviderSynchronization.changing = false;
  assert.equal(maintenance.recoveryState().cronEnabled, true);
  await maintenance.leave();
  assert.equal(maintenance.recoveryState(), null);
});

test("maintenance rejects a Gateway already transitioning before capturing scheduler intent", async (t) => {
  const f = cronFixture(t);
  f.services.assistantRuntime.status = () => ({ availability: "starting" });
  await assert.rejects(new AssistantMaintenance(f.services).enter(), { status: 409 });
  assert.equal(readJSON(f.paths.config).cron.enabled, true);
  assert.equal(fs.existsSync(path.join(f.paths.root, "runtime-maintenance.json")), false);
});
