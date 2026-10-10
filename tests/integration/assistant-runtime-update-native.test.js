import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { RuntimeUpdates } from "../../server/features/assistants/runtime-updates.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { runtimeManifest } from "../../server/features/assistants/runtime-manifest.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";
import { AssistantMaintenance } from "../../server/features/assistants/assistant-maintenance.js";
import { provisionTeamPlugin } from "../../server/features/assistants/team-plugin-install.js";

const installed = process.env.AGENTPIER_ASSISTANT_UPDATE_RUNTIME;
test(
  "isolated native Gateway stages, activates same pin, and restarts without accounts",
  {
    skip: !installed,
    timeout: 180000,
  },
  async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-native-update-"));
    const paths = runtimePaths(dataDir);
    const selection = path.join(paths.root, "runtime.json");
    const descriptor = {
      version: runtimeManifest.version,
      nodeVersion: runtimeManifest.nodeVersion,
      nodePath: path.resolve(installed, "node/bin/node"),
      entryPath: path.resolve(installed, "app/node_modules/openclaw/openclaw.mjs"),
    };
    // Same executables, but a distinct descriptor: re-staging an identical runtime
    // records no candidate, so the activation path needs a different selection.
    writePrivate(selection, { ...descriptor, version: "pre-update" });
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => readJSON(selection),
    });
    let maintenance = false;
    const updates = new RuntimeUpdates({
      dataDir,
      runtime,
      stage: async () => descriptor,
      maintenance: {
        enter: async () => {
          maintenance = true;
        },
        blockers: async () => [],
        quiesce: async () => {},
        validate: async () => {
          assert.equal(maintenance, true);
          const result = await runtime.client.call("agents.list", {});
          assert.ok(Array.isArray(result.agents));
        },
        leave: async () => {
          maintenance = false;
        },
      },
    });
    try {
      await runtime.start();
      assert.equal(runtime.client.ready, true);
      const previousPid = runtime.child.pid;
      await updates.stage();
      assert.equal(runtime.child.pid, previousPid);
      await updates.activate();
      assert.equal(updates.status().phase, "complete");
      assert.equal(maintenance, false);
      assert.notEqual(runtime.child.pid, previousPid);
      assert.equal(runtime.client.ready, true);
      await runtime.restart();
      assert.equal(runtime.client.ready, true);
      assert.deepEqual(readJSON(selection), descriptor);
      assert.ok(Array.isArray((await runtime.client.call("agents.list", {})).agents));
    } finally {
      await runtime.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
);

test(
  "native update gates overdue cron until commit and restores it without restarting Gateway",
  {
    skip: !installed,
    timeout: 180000,
  },
  async () => {
    const dataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "assistant-native-cron-update-"),
    );
    const paths = runtimePaths(dataDir);
    const selection = path.join(paths.root, "runtime.json");
    const descriptor = {
      version: runtimeManifest.version,
      nodeVersion: runtimeManifest.nodeVersion,
      nodePath: path.resolve(installed, "node/bin/node"),
      entryPath: path.resolve(installed, "app/node_modules/openclaw/openclaw.mjs"),
    };
    // Same executables, but a distinct descriptor: re-staging an identical runtime
    // records no candidate, so the activation path needs a different selection.
    writePrivate(selection, { ...descriptor, version: "pre-update" });
    const runtime = new RuntimeSupervisor({
      dataDir,
      install: async () => readJSON(selection),
    });
    const assistants = {
      maintenance: false,
      locks: new Map(),
      ledger: { pending: () => [] },
      store: { listAssistants: () => [], listConversations: () => [] },
      reconcile: async () => {},
    };
    runtime.maintenance = () => assistants.maintenance;
    const plugin = provisionTeamPlugin({ paths, runtimeVersion: descriptor.version });
    runtime.teamConfiguration = async () => ({
      directory: plugin.directory,
      connection: { url: "http://127.0.0.1:1", token: "fixture" },
      hostMaxConcurrent: 4,
      native: { token: "fixture-cron-token" },
      profiles: [],
    });
    const services = {
      assistants,
      assistantRuntime: runtime,
      assistantChannels: {
        pause: async () => {},
        resume() {},
        store: { list: () => [] },
      },
      assistantReminders: { webhook: { jobs: new Set() }, hasRunning: async () => false },
    };
    const maintenance = new AssistantMaintenance(services);
    let jobId,
      validated = false;
    const validate = maintenance.validate.bind(maintenance);
    maintenance.validate = async () => {
      await validate();
      assert.equal((await runtime.client.call("cron.status", {})).enabled, false);
      assert.deepEqual(
        (await runtime.client.call("cron.runs", { id: jobId })).entries,
        [],
      );
      validated = true;
    };
    const enter = maintenance.enter.bind(maintenance);
    maintenance.enter = async () => {
      const pid = runtime.child.pid;
      await enter();
      assert.equal(runtime.child.pid, pid);
      assert.equal(runtime.client.ready, true);
      assert.equal((await runtime.client.call("cron.status", {})).enabled, false);
      const job = await runtime.client.call("cron.add", {
        name: "isolated maintenance fixture",
        enabled: true,
        deleteAfterRun: false,
        schedule: { kind: "at", at: new Date(Date.now() + 1200).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Isolated maintenance fixture" },
      });
      jobId = job.id;
    };
    const leave = maintenance.leave.bind(maintenance);
    maintenance.leave = async () => {
      assert.equal(readJSON(path.join(paths.root, "update.json")).phase, "committed");
      const pid = runtime.child.pid;
      await leave();
      assert.equal(runtime.child.pid, pid);
      assert.equal(runtime.client.ready, true);
      assert.equal((await runtime.client.call("cron.status", {})).enabled, true);
    };
    const updates = new RuntimeUpdates({
      dataDir,
      runtime,
      maintenance,
      stage: async () => descriptor,
    });
    try {
      await runtime.start();
      assert.equal((await runtime.client.call("cron.status", {})).enabled, true);
      await updates.stage();
      await updates.activate();
      assert.equal(validated, true);
      assert.equal(updates.status().phase, "complete");
      assert.equal(assistants.maintenance, false);
      assert.equal(
        (await runtime.client.call("agents.list", {})).agents.length > 0,
        true,
      );
    } finally {
      await runtime.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  },
);
