import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { provisionEnabledRuntime } from "../../server/features/assistants/runtime-install.js";

test("enabled installation update preserves selection when provisioning fails", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-update-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dataDir, "assistants"));
  fs.writeFileSync(path.join(dataDir, "assistants", "settings.json"), '{"enabled":true}');
  fs.writeFileSync(
    path.join(dataDir, "assistants", "runtime.json"),
    '{"version":"previous"}',
  );
  await assert.rejects(
    provisionEnabledRuntime({
      dataDir,
      download: async () => {
        throw Error("interrupted download");
      },
    }),
    /interrupted/,
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataDir, "assistants", "runtime.json"))).version,
    "previous",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(dataDir, "assistants", "settings.json")))
      .enabled,
    true,
  );
});

test("staging the selected manifest again records no candidate", async (t) => {
  const { assistantInstallFixture } =
    await import("../helpers/assistant-install-fixture.js");
  const { ensureAssistantRuntime, stageAssistantRuntime } =
    await import("../../server/features/assistants/runtime-install.js");
  const { RuntimeUpdates } =
    await import("../../server/features/assistants/runtime-updates.js");
  const { dataDir, manifest, options } = assistantInstallFixture(t);
  await ensureAssistantRuntime(options);
  const candidate = path.join(dataDir, "assistants", "candidate.json");
  assert.equal(fs.existsSync(candidate), false);
  await stageAssistantRuntime(options);
  assert.equal(fs.existsSync(candidate), false);
  const updates = new RuntimeUpdates({
    dataDir,
    manifest,
    runtime: { status: () => ({ availability: "disabled" }) },
    maintenance: {},
    stage: () => stageAssistantRuntime(options),
    affected: () => ({ agents: 2, teamMembers: 10 }),
  });
  await updates.stage();
  assert.equal(fs.existsSync(candidate), false);
  const status = updates.status();
  // Temporary team members are counted apart from the owner's agents.
  assert.equal(status.affectedAssistants, 2);
  assert.equal(status.affectedTeamMembers, 10);
  assert.equal(status.updateAvailable, false);
  assert.equal(status.candidateReady, false);
  assert.equal(status.phase, "idle");
});

test("a second process installing concurrently gets RUNTIME_BUSY until its lock is stale", async (t) => {
  const { spawn } = await import("node:child_process");
  const { once } = await import("node:events");
  const { assistantInstallFixture } =
    await import("../helpers/assistant-install-fixture.js");
  const { stageAssistantRuntime } =
    await import("../../server/features/assistants/runtime-install.js");
  const { processIdentity } = await import("../../server/lib/process-identity.js");
  const { dataDir, options } = assistantInstallFixture(t);
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => other.kill("SIGKILL"));
  await once(other, "spawn");
  const lock = path.join(dataDir, "assistants", "runtimes", ".install.lock");
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(
    lock,
    JSON.stringify({ pid: other.pid, startTime: processIdentity(other.pid).startTime }),
  );
  await assert.rejects(stageAssistantRuntime(options), { code: "RUNTIME_BUSY" });
  assert.equal(fs.existsSync(lock), true);
  other.kill("SIGKILL");
  await once(other, "exit");
  assert.equal((await stageAssistantRuntime(options)).version, "2026.10.3");
  assert.equal(fs.existsSync(lock), false);
});

async function activationFixture(t, { candidate, migrate }) {
  const { RuntimeUpdates } =
    await import("../../server/features/assistants/runtime-updates.js");
  const { runtimePaths } =
    await import("../../server/features/assistants/runtime-paths.js");
  const { readJSON, writePrivate } = await import("../../server/lib/storage.js");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-migration-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  const selection = path.join(paths.root, "runtime.json");
  const journal = path.join(paths.root, "update.json");
  const previous = { version: "2026.10.3", nodeVersion: "26.12.1" };
  writePrivate(selection, previous);
  fs.writeFileSync(path.join(paths.state, "history"), "before");
  const calls = [];
  const runtime = {
    running: true,
    status() {
      return { availability: this.running ? "ready" : "disabled" };
    },
    async stop() {
      this.running = false;
    },
    async start() {
      calls.push(`start:${readJSON(selection).version}`);
      this.running = true;
    },
  };
  const maintenance = {
    enter: async () => {},
    blockers: async () => [],
    quiesce: async () => {},
    validate: async () => {},
    leave: async () => {},
  };
  const options = {
    dataDir,
    runtime,
    maintenance,
    stage: async () => candidate,
    freeSpace: async () => Number.MAX_SAFE_INTEGER,
    migrate: async (...args) => {
      const update = readJSON(journal);
      calls.push({
        migrate: args,
        phase: update.phase,
        backup: update.backup,
        selected: readJSON(selection).version,
        running: runtime.running,
      });
      return migrate?.(paths);
    },
  };
  const updates = new RuntimeUpdates(options);
  await updates.stage();
  return { RuntimeUpdates, paths, selection, journal, previous, calls, options, updates };
}

test("a version change migrates the stopped runtime's state before its first start", async (t) => {
  const candidate = { version: "2026.10.7", nodeVersion: "26.12.1", nodePath: "/n" };
  const f = await activationFixture(t, { candidate });
  await f.updates.activate();
  assert.equal(f.calls.length, 2);
  const [migration, start] = f.calls;
  assert.deepEqual(migration.migrate, [f.paths, candidate]);
  // Inside the fence: the snapshot exists, the candidate is selected, nothing runs.
  assert.equal(migration.phase, "migrating");
  assert.match(migration.backup, /^[a-f0-9-]{36}$/);
  assert.equal(migration.selected, "2026.10.7");
  assert.equal(migration.running, false);
  assert.equal(start, "start:2026.10.7");
  assert.equal(f.updates.status().phase, "complete");
});

test("a failed migration restores the snapshot and reports UPDATE_MIGRATION_FAILED", async (t) => {
  const candidate = { version: "2026.10.7", nodeVersion: "26.12.1" };
  const f = await activationFixture(t, {
    candidate,
    migrate: (paths) => {
      fs.writeFileSync(path.join(paths.state, "history"), "half migrated");
      throw Object.assign(Error("UPDATE_MIGRATION_FAILED"), {
        code: "UPDATE_MIGRATION_FAILED",
        status: 500,
      });
    },
  });
  await assert.rejects(f.updates.activate(), { code: "UPDATE_MIGRATION_FAILED" });
  const { readJSON } = await import("../../server/lib/storage.js");
  assert.deepEqual(readJSON(f.selection), f.previous);
  assert.equal(fs.readFileSync(path.join(f.paths.state, "history"), "utf8"), "before");
  assert.deepEqual(f.calls.slice(1), ["start:2026.10.3"]);
  const status = f.updates.status();
  assert.equal(status.phase, "rolled_back");
  assert.equal(status.diagnostic, "UPDATE_MIGRATION_FAILED");
});

test("a crash during the migration rolls back and removes Doctor's captures", async (t) => {
  const candidate = { version: "2026.10.7", nodeVersion: "26.12.1" };
  const { readJSON } = await import("../../server/lib/storage.js");
  const f = await activationFixture(t, {
    candidate,
    migrate: (paths) => {
      fs.writeFileSync(path.join(paths.state, "history"), "half migrated");
      fs.mkdirSync(path.join(paths.root, "state.update-captures", "doctor-1"), {
        recursive: true,
      });
      throw Error("process crashed");
    },
  });
  // The crash: the journal still says "migrating" when the next process starts.
  f.options.maintenance.leave = async () => {};
  f.options.runtime.stop = async () => {
    if (readJSON(f.journal).phase === "rolling_back") throw Error("crash");
    f.options.runtime.running = false;
  };
  await assert.rejects(f.updates.activate());
  const update = readJSON(f.journal);
  update.phase = "migrating";
  fs.writeFileSync(f.journal, JSON.stringify(update));
  f.options.runtime.stop = async () => {
    f.options.runtime.running = false;
  };
  const recovered = new f.RuntimeUpdates(f.options);
  assert.equal(recovered.status().recoveryRequired, true);
  await recovered.recover();
  assert.deepEqual(readJSON(f.selection), f.previous);
  assert.equal(fs.readFileSync(path.join(f.paths.state, "history"), "utf8"), "before");
  assert.equal(fs.existsSync(path.join(f.paths.root, "state.update-captures")), false);
  assert.equal(recovered.status().phase, "rolled_back");
});

test("a same-version runtime change never runs the migration", async (t) => {
  const candidate = { version: "2026.10.3", nodeVersion: "26.13.0" };
  const f = await activationFixture(t, { candidate });
  await f.updates.activate();
  assert.deepEqual(f.calls, ["start:2026.10.3"]);
  assert.equal(f.updates.status().phase, "complete");
});
