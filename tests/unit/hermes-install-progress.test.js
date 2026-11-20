import test from "node:test";
import assert from "node:assert/strict";
import { createHermesSwitch } from "../../server/features/assistants/runtimes/hermes/hermes-provisioning.js";
import { hermesInstallStep } from "../../web/features/assistants/runtimes/hermes/install-state.js";
import * as de from "../../web/lib/i18n/de/agents-hub.js";
import * as en from "../../web/lib/i18n/en/agents-hub.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The Hermes install (about 540 MB) says which step it is at (AGENTPIER-440 U3).
test("the switch's state names the running installation's step", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentpier-hermes-step-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let finish, report;
  const hermes = createHermesSwitch({
    dataDir,
    install: ({ onStep }) => {
      report = onStep;
      return new Promise((resolve) => (finish = resolve));
    },
    manifest: { version: "1.0.0" },
  });
  const started = await hermes.enable();
  assert.equal(started.installing, true);
  assert.equal(started.installStep, null);
  await new Promise((resolve) => setImmediate(resolve));
  report("packages");
  assert.deepEqual(hermes.state().installStep, { step: "packages", index: 3, of: 5 });
  finish(null);
  await hermes.settled();
  assert.equal(hermes.state().installStep, null);
});

test("the page reads only a known step of a running installation", () => {
  const at = { step: "tools", index: 5, of: 5 };
  assert.deepEqual(hermesInstallStep({ installing: true, installStep: at }), at);
  assert.equal(hermesInstallStep({ installing: false, installStep: at }), null);
  assert.equal(
    hermesInstallStep({ installing: true, installStep: { ...at, step: "evil" } }),
    null,
  );
  assert.equal(
    hermesInstallStep({ installing: true, installStep: { ...at, index: 6 } }),
    null,
  );
  assert.equal(hermesInstallStep(null), null);
});

test("each step reads in both languages", () => {
  for (const catalog of [de, en]) {
    const copy = Object.values(catalog)[0].runtime.hermes;
    for (const step of ["download", "python", "packages", "check", "tools"])
      assert.ok(copy.installSteps[step], step);
  }
  const copy = Object.values(en)[0].runtime.hermes;
  assert.equal(
    copy.installStep(3, 5, copy.installSteps.packages),
    "Installing Hermes Agent: step 3 of 5, installing the Python packages (about 540 MB) …",
  );
});
