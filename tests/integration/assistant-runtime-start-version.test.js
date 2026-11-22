import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { GuardedRuntimeSupervisor as RuntimeSupervisor } from "../helpers/process-guard.js";

// A start's dependence on the OpenClaw version it runs and on its startup settle
// (OpenClaw 2026.11.6's /startupz wait, gateway-client.js settleStartup).

test("a start compiles the heartbeat setting of the OpenClaw version it runs", async (t) => {
  for (const [version, heartbeat] of [
    ["2026.11.3", { every: "0m" }],
    ["2026.11.6", undefined],
  ]) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-heartbeat-"));
    t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
    const entryPath = path.join(dataDir, "invalid.mjs");
    fs.writeFileSync(entryPath, "process.exit(78)");
    const supervisor = new RuntimeSupervisor({
      dataDir,
      install: async () => ({ nodePath: process.execPath, entryPath, version }),
    });
    t.after(() => supervisor.close());
    await assert.rejects(supervisor.start(), { code: "INVALID_CONFIG" });
    const config = JSON.parse(fs.readFileSync(supervisor.paths.config, "utf8"));
    assert.deepEqual(config.agents.defaults.heartbeat, heartbeat, version);
  }
});

test("a Gateway that exits while its startup settles never reports ready", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-settle-exit-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entryPath = path.join(dataDir, "exits.mjs");
  fs.writeFileSync(entryPath, "setTimeout(() => process.exit(1), 150)");
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => ({ nodePath: process.execPath, entryPath, version: "fixture" }),
    timing: { restartMs: 60000 },
    clientFactory: () =>
      Object.assign(new EventEmitter(), {
        ready: false,
        async connect() {
          this.ready = true;
        },
        // Still settling when the process exits.
        settleStartup: () => new Promise((resolve) => setTimeout(resolve, 600)),
        close() {
          this.ready = false;
        },
      }),
  });
  t.after(() => runtime.close());
  await assert.rejects(runtime.start(), { code: "PROCESS_EXIT" });
  assert.notEqual(runtime.status().availability, "ready");
});

test("the startup settle does not grow the next start's readiness budget", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-settle-budget-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entryPath = path.join(dataDir, "alive.mjs");
  fs.writeFileSync(entryPath, "setInterval(() => {}, 1000)");
  const runtime = new RuntimeSupervisor({
    dataDir,
    install: async () => ({ nodePath: process.execPath, entryPath, version: "fixture" }),
    clientFactory: () =>
      Object.assign(new EventEmitter(), {
        ready: false,
        async connect() {
          this.ready = true;
        },
        settleStartup: () => new Promise((resolve) => setTimeout(resolve, 500)),
        close() {
          this.ready = false;
        },
      }),
  });
  t.after(() => runtime.close());
  await runtime.start();
  assert.equal(runtime.status().availability, "ready");
  // Measured at the connection: the settle wait is bounded by the deadline itself.
  assert.ok(runtime.lastReadyMs < 450, `${runtime.lastReadyMs} ms`);
});
