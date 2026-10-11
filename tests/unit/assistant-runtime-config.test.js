import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtime-config.js";
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
