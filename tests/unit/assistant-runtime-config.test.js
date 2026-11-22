import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtimes/openclaw/runtime-config.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

test("the Gateway keeps its host terminal and Control UI off, also against an existing configuration", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234);
  let config = readJSON(paths.config);
  // OpenClaw opens a host shell for admin clients unless the terminal is disabled.
  assert.equal(config.gateway.terminal.enabled, false);
  assert.equal(config.gateway.controlUi.enabled, false);
  writePrivate(paths.config, {
    ...config,
    gateway: {
      ...config.gateway,
      terminal: { enabled: true },
      controlUi: { enabled: true },
    },
  });
  prepareRuntimeConfig(paths, 1234);
  config = readJSON(paths.config);
  assert.equal(config.gateway.terminal.enabled, false);
  assert.equal(config.gateway.controlUi.enabled, false);
});

test("the heartbeat monitor stays off on 2026.11.3 and its key is gone from 2026.11.6 on", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-config-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  const seed = () => {
    prepareRuntimeConfig(paths, 1234);
    const config = readJSON(paths.config);
    config.agents.defaults.heartbeat = { every: "30m" };
    config.agents.entries.main = { ...config.agents.entries.main, heartbeat: {} };
    writePrivate(paths.config, config);
  };
  // 2026.11.3 runs its monitor every 30 minutes without a key: AgentPier turns it off.
  seed();
  prepareRuntimeConfig(paths, 1234, undefined, { version: "2026.11.3" });
  let config = readJSON(paths.config);
  assert.deepEqual(config.agents.defaults.heartbeat, { every: "0m" });
  assert.equal(config.agents.entries.main.heartbeat, undefined);
  // 2026.11.6 refuses to start with the retired key, on the defaults or an agent;
  // without a version the compile is for the pinned runtime.
  for (const version of ["2026.11.6", "2026.11.7", undefined]) {
    seed();
    prepareRuntimeConfig(paths, 1234, undefined, { version });
    config = readJSON(paths.config);
    assert.equal("heartbeat" in config.agents.defaults, false, version);
    assert.equal(config.agents.entries.main.heartbeat, undefined, version);
  }
});
