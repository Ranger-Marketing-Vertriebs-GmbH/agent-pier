import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createOpenClawRuntime } from "../../server/features/assistants/runtimes/openclaw/openclaw-runtime.js";
import { runtimeManifest } from "../../server/features/assistants/runtimes/openclaw/runtime-manifest.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { assistantInstallFixture } from "../helpers/assistant-install-fixture.js";

const hostOf = (supervisor = {}) => createOpenClawRuntime(supervisor).host;
const dataDirectory = (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-lifecycle-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return dataDir;
};

test("the OpenClaw host ships the manifest's version and recognises its records", () => {
  const host = hostOf();
  assert.deepEqual(host.target(), {
    version: runtimeManifest.version,
    nodeVersion: runtimeManifest.nodeVersion,
  });
  const shipped = {
    version: runtimeManifest.version,
    nodeVersion: runtimeManifest.nodeVersion,
    dependencyLockSha256: runtimeManifest.dependencyLockSha256,
  };
  assert.equal(host.current(shipped), true);
  // Another lock of the same version is another runtime: an update is due.
  assert.equal(host.current({ ...shipped, dependencyLockSha256: "other" }), false);
  assert.equal(host.current({ ...shipped, version: "2026.1.1" }), false);
});

test("the OpenClaw host installs into the data folder and compares install records", async (t) => {
  const { dataDir, options } = assistantInstallFixture(t);
  const host = hostOf();
  const record = await host.install(options);
  assert.equal(record.version, options.manifest.version);
  assert.equal(host.sameInstall(record, structuredClone(record)), true);
  assert.equal(host.sameInstall(record, { ...record, entryPath: "/elsewhere" }), false);
  // Nothing selected yet: the install is recorded as the candidate to activate.
  const candidate = JSON.parse(
    fs.readFileSync(path.join(dataDir, "assistants", "candidate.json"), "utf8"),
  );
  assert.equal(host.sameInstall(candidate, record), true);
});

test("the OpenClaw host stages no update while agents are off", (t) => {
  const dataDir = dataDirectory(t);
  assert.equal(hostOf().stageUpdate({ dataDir }), null);
  assert.equal(fs.existsSync(path.join(dataDir, "assistants")), false);
});

test("the OpenClaw host clears Doctor's leftovers after a rollback", (t) => {
  const paths = runtimePaths(dataDirectory(t));
  const agent = path.join(paths.state, "agents", "main", "agent");
  fs.mkdirSync(agent, { recursive: true });
  const leftover = path.join(agent, "agent.db.pre-startup-migration-1.bak");
  fs.writeFileSync(leftover, "plain copy");
  fs.writeFileSync(path.join(agent, "agent.db"), "kept");
  const captures = path.join(paths.root, "state.update-captures");
  fs.mkdirSync(captures);
  hostOf().clearMigration(paths);
  assert.equal(fs.existsSync(leftover), false);
  assert.equal(fs.existsSync(captures), false);
  assert.equal(fs.readFileSync(path.join(agent, "agent.db"), "utf8"), "kept");
});

test("the OpenClaw host's restart reasons follow the supervisor", async () => {
  const supervisor = { state: "disabled", generationId: null };
  supervisor.status = () => ({ availability: supervisor.state });
  const host = hostOf(supervisor);
  // A stopped Gateway compiles saved changes at its next start.
  assert.equal(host.restartNeeded(), false);
  supervisor.state = "starting";
  assert.equal(host.restartNeeded(), true);
  assert.equal(host.generation(), null);
  supervisor.generationId = "g-1";
  assert.equal(host.generation(), "g-1");
  // A stand-in without status answers by its client's readiness.
  assert.equal(hostOf({ client: { ready: true } }).restartNeeded(), true);
  assert.equal(hostOf({ client: { ready: false } }).restartNeeded(), false);
});

test("the OpenClaw host asks the supervisor whether its Gateway stopped", async () => {
  await hostOf({}).assertStopped();
  const conflict = Object.assign(Error("running"), { code: "OWNERSHIP_CONFLICT" });
  await assert.rejects(
    hostOf({ assertStopped: async () => Promise.reject(conflict) }).assertStopped(),
    { code: "OWNERSHIP_CONFLICT" },
  );
  // No recorded Doctor: nothing to stop before a restore.
  await hostOf().stopMigration(null);
});
