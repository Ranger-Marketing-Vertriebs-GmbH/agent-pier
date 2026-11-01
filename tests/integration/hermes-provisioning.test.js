import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { hermesInstallFixture } from "../helpers/hermes-install-fixture.js";
import { setupFixture } from "../helpers/setup-fixture.js";
import {
  createHermesSwitch,
  hermesEnabled,
  hermesStagingDue,
  provisionInstallerHermes,
  stageHermesInBackground,
  writeHermesEnabled,
} from "../../server/features/assistants/runtimes/hermes/hermes-provisioning.js";
import { ensureHermesRuntime } from "../../server/features/assistants/runtimes/hermes/hermes-install.js";
import {
  createHermesUpdates,
  hermesLifecycle,
} from "../../server/features/assistants/runtimes/hermes/hermes-lifecycle.js";
import { hermesPaths } from "../../server/features/assistants/runtimes/hermes/hermes-paths.js";
import { applyRetention } from "../../server/features/assistants/runtime-retention.js";
import { provisionHermesContractRuntime } from "../../scripts/provision-hermes-contracts.mjs";
import { runInstaller } from "../../scripts/release-install.mjs";
import { installerArguments, resolveSetupOptions } from "../../scripts/setup-options.mjs";
import { readJSON } from "../../server/lib/storage.js";

const settings = (dataDir) => path.join(dataDir, "assistants", "settings.json");

test("the Hermes opt-in lives beside the runtime switch in the settings store", (t) => {
  const f = hermesInstallFixture(t);
  assert.equal(hermesEnabled(f.dataDir), false);
  assert.equal(fs.existsSync(path.join(f.dataDir, "assistants")), false);
  fs.mkdirSync(path.join(f.dataDir, "assistants"));
  fs.writeFileSync(settings(f.dataDir), JSON.stringify({ enabled: true }));
  writeHermesEnabled(f.dataDir, true);
  assert.deepEqual(readJSON(settings(f.dataDir)), {
    enabled: true,
    hermes: { enabled: true },
  });
  writeHermesEnabled(f.dataDir, false);
  assert.equal(hermesEnabled(f.dataDir), false);
  assert.equal(readJSON(settings(f.dataDir)).enabled, true);
});

test("--with-hermes records the opt-in and installs; without it nothing happens", async (t) => {
  const f = hermesInstallFixture(t);
  const ensure = (options) => ensureHermesRuntime({ ...f.options, ...options });
  assert.equal(await provisionInstallerHermes({ dataDir: f.dataDir }, { ensure }), null);
  assert.equal(f.calls.length, 0);
  const ready = await provisionInstallerHermes(
    { dataDir: f.dataDir, enable: true },
    { ensure },
  );
  assert.deepEqual(ready, { status: "ready", version: f.manifest.version });
  assert.equal(hermesEnabled(f.dataDir), true);
  // An enabled installation is provisioned on a rerun without the flag.
  assert.deepEqual(
    await provisionInstallerHermes({ dataDir: f.dataDir }, { ensure }),
    ready,
  );
  const failed = await provisionInstallerHermes(
    { dataDir: f.dataDir },
    {
      ensure: async () =>
        Promise.reject(
          Object.assign(Error("/private/x"), { code: "HERMES_CHECKSUM_MISMATCH" }),
        ),
    },
  );
  assert.deepEqual(failed, { status: "failed", code: "HERMES_CHECKSUM_MISMATCH" });
});

test("the update path stages a newer pin only while Hermes is enabled", async (t) => {
  const f = hermesInstallFixture(t);
  assert.equal(stageHermesInBackground(f.options), null);
  writeHermesEnabled(f.dataDir, true);
  assert.equal(hermesStagingDue(f.dataDir, f.manifest), true);
  // A first opt-in without an installation installs and selects.
  const first = await stageHermesInBackground(f.options, {
    ensure: (options) => ensureHermesRuntime(options),
  });
  assert.equal(
    readJSON(path.join(f.dataDir, "assistants/hermes/runtime.json")).version,
    first.version,
  );
  assert.equal(hermesStagingDue(f.dataDir, f.manifest), false);
  assert.equal(stageHermesInBackground(f.options), null);
  // An AgentPier update that pins another commit stages it beside the selection.
  const next = hermesInstallFixture(t, {
    commit: "d".repeat(40),
    releaseDate: "2026.10.2",
  });
  const options = { ...next.options, dataDir: f.dataDir };
  assert.equal(hermesStagingDue(f.dataDir, next.manifest), true);
  const staged = await stageHermesInBackground(options);
  assert.equal(
    readJSON(path.join(f.dataDir, "assistants/hermes/runtime.json")).version,
    first.version,
  );
  assert.equal(
    readJSON(path.join(f.dataDir, "assistants/hermes/candidate.json")).version,
    staged.version,
  );
  assert.equal(hermesStagingDue(f.dataDir, next.manifest), false);
  // A failure is logged by stable code only and never rejects.
  writeHermesEnabled(next.dataDir, true);
  const errors = [];
  t.mock.method(console, "error", (line) => errors.push(line));
  const result = await stageHermesInBackground(next.options, {
    ensure: async () =>
      Promise.reject(
        Object.assign(Error("/secret/path"), { code: "HERMES_INSTALL_FAILED" }),
      ),
  });
  assert.equal(result, null);
  assert.deepEqual(errors, [
    "AgentPier could not prepare the Hermes runtime: HERMES_INSTALL_FAILED",
  ]);
});

test("the Hermes switch installs in the background and reports the installation", async (t) => {
  const f = hermesInstallFixture(t);
  const hermes = createHermesSwitch({
    dataDir: f.dataDir,
    install: (options) => ensureHermesRuntime({ ...f.options, ...options }),
    manifest: f.manifest,
  });
  let changes = 0;
  hermes.onChange = () => changes++;
  assert.equal(hermes.state().enabled, false);
  const state = await hermes.enable();
  assert.equal(state.enabled, true);
  assert.equal(state.installing, true);
  await hermes.settled();
  assert.equal(changes, 1);
  assert.equal(hermes.state().installed, true);
  assert.equal(hermes.state().version, f.manifest.version);
  assert.equal(hermes.state().error, null);
  assert.equal((await hermes.disable()).enabled, false);
  // The installation stays for the next opt-in, which installs nothing.
  assert.equal(hermes.state().installed, true);
  assert.equal((await hermes.enable()).installing, false);
});

test("a failed Hermes activation restores the snapshot of every agent's home", async (t) => {
  const f = hermesInstallFixture(t);
  const old = await ensureHermesRuntime(f.options);
  const paths = hermesPaths(f.dataDir);
  const config = path.join(paths.state, "agent-1", "config.yaml");
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, "_config_version: 1\n");
  const next = hermesInstallFixture(t, {
    commit: "e".repeat(40),
    releaseDate: "2026.10.3",
  });
  const calls = [];
  let running = true;
  const supervisor = {
    status: () => ({ availability: running ? "ready" : "disabled" }),
    assertStopped: async () => assert.equal(running, false),
  };
  const host = {
    ...hermesLifecycle(supervisor),
    install: () =>
      ensureHermesRuntime({ ...next.options, dataDir: f.dataDir }).then(() =>
        readJSON(path.join(paths.root, "candidate.json")),
      ),
    current: () => false,
    status: supervisor.status,
    async stop() {
      calls.push("stop");
      running = false;
    },
    async start() {
      const selected = readJSON(path.join(paths.root, "runtime.json"));
      calls.push(`start:${selected.version}`);
      // The new Hermes migrates its configuration when it starts.
      if (selected.version !== old.version)
        fs.writeFileSync(config, "_config_version: 2\n");
      running = true;
    },
  };
  let validations = 0;
  const maintenance = {
    enter: async () => {},
    blockers: async () => [],
    quiesce: async () => {},
    leave: async () => {},
    async validate() {
      if (++validations === 1)
        throw Object.assign(Error("refused"), { code: "VALIDATION_FAILED" });
    },
  };
  const updates = createHermesUpdates({
    dataDir: f.dataDir,
    host,
    maintenance,
    freeSpace: async () => 1e12,
  });
  await updates.stage();
  assert.equal(updates.status().candidateReady, true);
  await updates.activate().catch(() => {});
  assert.equal(fs.readFileSync(config, "utf8"), "_config_version: 1\n");
  assert.equal(readJSON(path.join(paths.root, "runtime.json")).version, old.version);
  assert.deepEqual(
    calls.filter((call) => call.startsWith("start:")),
    [`start:${next.manifest.version}`, `start:${old.version}`],
  );
  assert.equal(updates.status().phase, "rolled_back");
});

test("retention keeps the Hermes installations a record names", async (t) => {
  const f = hermesInstallFixture(t);
  const record = await ensureHermesRuntime(f.options);
  const paths = hermesPaths(f.dataDir);
  const stray = path.join(paths.runtimes, "stray-install");
  fs.mkdirSync(stray);
  await applyRetention(paths);
  assert.ok(fs.existsSync(record.directory));
  assert.equal(fs.existsSync(stray), false);
});

test("the contract provisioning exports the installation for the native Hermes contracts", async (t) => {
  const f = hermesInstallFixture(t);
  const env = await provisionHermesContractRuntime(f.dataDir, {
    provision: (options) =>
      provisionInstallerHermes(options, {
        ensure: (more) => ensureHermesRuntime({ ...f.options, ...more }),
      }),
  });
  const selected = readJSON(path.join(f.dataDir, "assistants/hermes/runtime.json"));
  assert.deepEqual(env, { AGENTPIER_HERMES_CONTRACT_RUNTIME: selected.directory });
  await assert.rejects(provisionHermesContractRuntime("relative"), /absolute/);
});

test("setup, the shell entrypoints and the release installer carry --with-hermes", async (t) => {
  const options = resolveSetupOptions(["--with-hermes"], {
    home: "/Users/test",
    env: {},
    platform: "darwin",
    arch: "arm64",
  });
  assert.equal(options.withHermes, true);
  assert.ok(installerArguments(options, "1.2.3").includes("--with-hermes"));
  const validate = (call) =>
    execFileSync("/bin/sh", ["-c", `. scripts/install-bootstrap.sh && ${call}`], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, HOME: "/Users/fixture" },
    });
  validate("validate_installer_options --install-root /a --data-dir /b --with-hermes");
  validate("validate_setup_options --with-hermes");
  assert.match(fs.readFileSync("scripts/setup.sh", "utf8"), /--with-hermes/);
  const f = await setupFixture(t);
  const seen = [];
  const hermes = async (input) => (seen.push(input), { status: "ready", version: "x" });
  const result = await runInstaller(
    [
      "--archive",
      f.options.archive,
      "--install-root",
      f.installRoot,
      "--data-dir",
      f.dataDir,
      "--with-hermes",
    ],
    { ...f.dependencies, hermes },
  );
  assert.deepEqual(seen, [{ dataDir: f.dataDir, enable: true }]);
  assert.deepEqual(result.hermesRuntime, { status: "ready", version: "x" });
});
