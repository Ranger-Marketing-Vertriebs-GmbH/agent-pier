import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hermesInstallFixture } from "../helpers/hermes-install-fixture.js";
import { ensureHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-install.js";
import { hermesManifest } from "../../server/features/assistants/runtimes/hermes/hermes-manifest.js";
import { hermesExecutables } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { hermesEnvironment } from "../../server/features/assistants/runtimes/hermes/hermes-environment.js";
import {
  hermesStagingDue,
  writeHermesEnabled,
} from "../../server/features/assistants/runtimes/hermes/hermes-provisioning.js";

// Since Hermes v0.23 its only browser is browser_exec, whose engine (browser-harness)
// is a core dependency of Hermes's own environment: AgentPier provisions no
// agent-browser binary any more and checks the engine imports instead.

test("the pin names no agent-browser and an installation adds none", async (t) => {
  assert.equal("agentBrowser" in hermesManifest, false);
  const f = hermesInstallFixture(t);
  const record = await ensureHermesRuntime(f.options);
  assert.deepEqual(fs.readdirSync(hermesExecutables(record.directory).tools), [
    "pdfium.json",
  ]);
  assert.equal(
    f.calls.some((call) => /agent-browser/.test(call.download || "")),
    false,
  );
  // The identity check imports browser_exec's engine.
  const probe = f.calls.find((call) => call.file?.endsWith("/venv/bin/python"));
  assert.match(probe.args.join(" "), /\bbrowser_harness\b/);
});

test("an installation of the previous pin with its agent-browser stays as it is", async (t) => {
  const f = hermesInstallFixture(t);
  writeHermesEnabled(f.dataDir, true);
  const record = await ensureHermesRuntime(f.options);
  const { tools } = hermesExecutables(record.directory);
  fs.writeFileSync(path.join(tools, "agent-browser"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(tools, "agent-browser.json"), "{}\n");
  // Nothing is due for it, and the agents' PATH no longer names its tools/.
  assert.equal(hermesStagingDue(f.dataDir, f.manifest), false);
  const env = hermesEnvironment({
    agent: { home: "/h", hermesHome: "/h/state", tmp: "/h/tmp" },
    runtime: record,
    parent: {},
  });
  assert.equal(env.PATH.split(path.delimiter).includes(tools), false);
});
