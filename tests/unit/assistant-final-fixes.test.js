import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AssistantStore } from "../../server/features/assistants/assistant-store.js";
import { AssistantService } from "../../server/features/assistants/assistant-service.js";
import { detectBrowser } from "../../server/features/assistants/browser-detection.js";
import {
  freePort,
  maxGatewayPort,
} from "../../server/features/assistants/runtime-supervisor.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { prepareRuntimeConfig } from "../../server/features/assistants/runtime-config.js";
import { webToolsSections } from "../../server/features/assistants/openclaw-config/web-tools.js";
import { readJSON, writePrivate } from "../../server/lib/storage.js";

test("create stores web capabilities as off and keeps memory and reminders", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-create-caps-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = new AssistantStore({ dataDir });
  t.after(() => store.close());
  const service = {
    admit: (operation) => operation(),
    models: { resolve: async () => ({ release() {} }) },
    store,
    changed() {},
  };
  const record = await AssistantService.prototype.create.call(service, {
    name: "A",
    instructions: "",
    model: { connectionId: "c", modelId: "m" },
    capabilities: {
      memory: true,
      reminders: true,
      webSearch: true,
      webFetch: true,
      browser: true,
      documents: true,
    },
  });
  assert.deepEqual(record.capabilities, {
    memory: true,
    reminders: true,
    webSearch: false,
    webFetch: false,
    browser: false,
    documents: false,
  });
  assert.deepEqual(store.getAssistant(record.id).capabilities, record.capabilities);
});

test("snap Chromium is never chosen as the browser", () => {
  for (const snap of ["/snap/bin/chromium", "/usr/bin/chromium-browser"])
    assert.deepEqual(
      detectBrowser({ platform: "linux", exists: (p) => p === snap, home: "/home/x" }),
      { available: false, visible: { available: false, reason: "noApp" } },
    );
});

test("the Gateway port leaves room for every CDP port", async () => {
  const drawn = [65530, 65426, 65425, 40000];
  assert.equal(await freePort({ draw: async () => drawn.shift() }), 65425);
  assert.equal(maxGatewayPort + 110, 65535);
  const profiles = Array.from({ length: 120 }, (_, n) => ({
    id: `a${String(n).padStart(3, "0")}`,
    capabilities: { browser: true },
  }));
  const sections = webToolsSections({
    profiles,
    webTools: { browser: { available: true, executablePath: "/b" } },
    port: maxGatewayPort,
  });
  const ports = Object.values(sections.browser.profiles).map((p) => p.cdpPort);
  assert.equal(Math.max(...ports), 65535);
  assert.equal(new Set(ports).size, ports.length);
  // Member slots keep their ports; agents beyond the range get no profile.
  assert.equal(ports.length, 2 + 3 + 91);
});

test("leftover mcp, secrets and env blocks are removed from an existing configuration", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-config-locked-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const paths = runtimePaths(dir);
  prepareRuntimeConfig(paths, 1234);
  writePrivate(paths.config, {
    ...readJSON(paths.config),
    mcp: { servers: { x: { command: "sh" } } },
    secrets: { providers: { p: { source: "exec", command: "sh" } } },
    env: { LD_PRELOAD: "/tmp/x" },
  });
  prepareRuntimeConfig(paths, 1234);
  const config = readJSON(paths.config);
  for (const key of ["mcp", "secrets", "env"]) assert.equal(key in config, false, key);
});
