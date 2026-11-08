import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hermesInstallFixture } from "../helpers/hermes-install-fixture.js";
import {
  ensureHermesRuntime,
  hasAgentBrowser,
  stageHermesRuntime,
} from "../../server/features/assistants/runtimes/hermes/hermes-install.js";
import {
  hermesManifest,
  validHermesManifest,
} from "../../server/features/assistants/runtimes/hermes/hermes-manifest.js";
import { hermesExecutables } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import {
  hermesStagingDue,
  writeHermesEnabled,
} from "../../server/features/assistants/runtimes/hermes/hermes-provisioning.js";

// Hermes's browser tools run agent-browser against the Chromium AgentPier starts; the
// installation provisions the binary Hermes's own package lock pins, so Hermes never
// installs it (or the Chromium it would bring) at run time.

test("the manifest pins the agent-browser release of Hermes's package lock", () => {
  assert.equal(hermesManifest.agentBrowser.version, "0.26.0");
  assert.equal(
    hermesManifest.agentBrowser.url,
    "https://registry.npmjs.org/agent-browser/-/agent-browser-0.26.0.tgz",
  );
  assert.match(hermesManifest.agentBrowser.sha256, /^[0-9a-f]{64}$/);
  const { agentBrowser: _pin, ...without } = hermesManifest;
  assert.throws(() => validHermesManifest(without), /manifest/);
  assert.throws(
    () =>
      validHermesManifest({
        ...hermesManifest,
        agentBrowser: { ...hermesManifest.agentBrowser, url: "https://example.test/x" },
      }),
    /manifest/,
  );
});

test("an installation puts the platform's agent-browser on Hermes's PATH", async (t) => {
  const f = hermesInstallFixture(t);
  const record = await ensureHermesRuntime(f.options);
  const { agentBrowser, tools } = hermesExecutables(record.directory);
  assert.equal(fs.statSync(agentBrowser).mode & 0o777, 0o755);
  assert.match(fs.readFileSync(agentBrowser, "utf8"), /agent-browser/);
  assert.ok(hasAgentBrowser(record.directory, f.manifest));
  assert.deepEqual(fs.readdirSync(tools).sort(), [
    "agent-browser",
    "agent-browser.json",
    "pdfium.json",
  ]);
  assert.equal(
    f.calls.filter((call) => call.download === f.manifest.agentBrowser.url).length,
    1,
  );
});

test("an installation from before the browser gets agent-browser at the next staging", async (t) => {
  const f = hermesInstallFixture(t);
  writeHermesEnabled(f.dataDir, true);
  const record = await ensureHermesRuntime(f.options);
  const { tools } = hermesExecutables(record.directory);
  for (const name of ["agent-browser", "agent-browser.json"])
    fs.rmSync(path.join(tools, name));
  assert.equal(hermesStagingDue(f.dataDir, f.manifest), true);
  const before = f.calls.length;
  assert.deepEqual(await stageHermesRuntime(f.options), record);
  // Only agent-browser is fetched; the installation itself stays as it was.
  assert.deepEqual(
    f.calls.slice(before).filter((call) => call.download),
    [{ download: f.manifest.agentBrowser.url }],
  );
  assert.ok(hasAgentBrowser(record.directory, f.manifest));
  assert.equal(hermesStagingDue(f.dataDir, f.manifest), false);
  assert.equal(
    fs.existsSync(path.join(f.dataDir, "assistants/hermes/candidate.json")),
    false,
  );
});

test("a changed agent-browser archive installs nothing", async (t) => {
  const f = hermesInstallFixture(t);
  f.tamper(f.manifest.agentBrowser.url, Buffer.from("changed"));
  await assert.rejects(ensureHermesRuntime(f.options), {
    code: "HERMES_CHECKSUM_MISMATCH",
  });
  assert.deepEqual(
    fs.readdirSync(path.join(f.dataDir, "assistants/hermes/runtimes")),
    [],
  );
});
