import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { applicationFixture, enabledAssistants } from "../helpers/application.js";
import { hermesInstallFixture } from "../helpers/hermes-install-fixture.js";
import { createHermesSwitch } from "../../server/features/assistants/runtimes/hermes/hermes-provisioning.js";
import { ensureHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-install.js";

test("the owner enables Hermes through the agent routes; runtime actions keep the opt-in", async (t) => {
  const f = await applicationFixture(t, enabledAssistants);
  const install = hermesInstallFixture(t);
  // The switch over the fixture's archives, before the agent routes are built.
  const hermes = createHermesSwitch({
    dataDir: f.dataDir,
    install: (options) => ensureHermesRuntime({ ...install.options, ...options }),
    manifest: install.manifest,
  });
  f.application.hermesRuntime = hermes;
  const initial = await (await f.request("/api/assistant-runtime/hermes")).json();
  assert.equal(initial.enabled, false);
  assert.equal(initial.installed, false);
  const invalid = await f.request("/api/assistant-runtime/hermes", {
    method: "PUT",
    body: { enabled: "yes" },
  });
  assert.equal(invalid.status, 400);
  const enabled = await f.request("/api/assistant-runtime/hermes", {
    method: "PUT",
    body: { enabled: true },
  });
  assert.equal(enabled.status, 200);
  assert.equal((await enabled.json()).enabled, true);
  await hermes.settled();
  const state = await (await f.request("/api/assistant-runtime/hermes")).json();
  assert.equal(state.installed, true);
  assert.equal(state.version, install.manifest.version);
  // The OpenClaw runtime switch rewrites the store without dropping the opt-in.
  const settings = path.join(f.dataDir, "assistants", "settings.json");
  const stopped = await f.request("/api/assistant-runtime/stop", { method: "POST" });
  assert.equal(stopped.status, 202);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, "utf8")), {
    enabled: false,
    hermes: { enabled: true },
  });
  const disabled = await f.request("/api/assistant-runtime/hermes", {
    method: "PUT",
    body: { enabled: false },
  });
  assert.equal((await disabled.json()).enabled, false);
});
