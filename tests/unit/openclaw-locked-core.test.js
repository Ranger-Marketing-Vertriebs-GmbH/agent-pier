import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtime-config.js";
import { isLockedPath } from "../../server/features/assistants/openclaw-config/locked-core.js";
import { readJSON } from "../../server/lib/storage.js";

test("a drifted configuration is hardened again on the next start", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "locked-core-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234);
  const drifted = readJSON(paths.config);
  Object.assign(drifted, {
    channels: { telegram: { botToken: "x" } },
    browser: { enabled: true },
    skills: { allowBundled: ["github"] },
    discovery: { mdns: { mode: "full" } },
    telemetry: { enabled: true },
    update: { checkOnStart: true, auto: { enabled: true } },
  });
  drifted.agents.defaults.heartbeat = { every: "30m" };
  drifted.gateway.terminal = { enabled: true };
  fs.writeFileSync(paths.config, JSON.stringify(drifted));
  prepareRuntimeConfig(paths, 1234);
  const config = readJSON(paths.config);
  assert.deepEqual(config.channels, {});
  assert.equal(config.browser.enabled, false);
  assert.deepEqual(config.skills.allowBundled, []);
  assert.equal(config.discovery.mdns.mode, "off");
  assert.equal(config.telemetry.enabled, false);
  assert.deepEqual(config.update, { checkOnStart: false, auto: { enabled: false } });
  assert.deepEqual(config.agents.defaults.heartbeat, { every: "0m" });
  assert.equal(config.gateway.terminal.enabled, false);
});

test("locked paths include their children and their parents", () => {
  assert.equal(isLockedPath("gateway.auth.token"), true);
  assert.equal(isLockedPath("gateway"), true);
  assert.equal(isLockedPath("agents"), true);
  assert.equal(isLockedPath(""), true);
  assert.equal(isLockedPath("agents.defaults.skills"), true);
  assert.equal(isLockedPath("models.providers.x"), false);
  assert.equal(isLockedPath("agents.defaults.timeoutSeconds"), false);
});
