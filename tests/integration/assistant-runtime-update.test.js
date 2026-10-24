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
      return migrate?.(paths, args[2]);
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
  assert.deepEqual(migration.migrate.slice(0, 2), [f.paths, candidate]);
  assert.equal(typeof migration.migrate[2].onSpawn, "function");
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

// Polls `ready` until it holds, failing the test after 10 s instead of hanging.
async function waitFor(ready, what) {
  for (const end = Date.now() + 10000; !ready();) {
    assert.ok(Date.now() < end, `timed out waiting for the ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// A long-running Doctor leading its own process group, with a grandchild in it. A
// launcher starts it and exits, so it is nobody's child here, like a Doctor whose
// AgentPier process crashed (a child of this process would linger as a zombie).
async function liveDoctor(t, folder) {
  const { execFileSync } = await import("node:child_process");
  const { ownerRecord } =
    await import("../../server/features/assistants/gateway-ownership.js");
  const entryPath = path.join(folder, "fake-doctor.mjs");
  const launcher = path.join(folder, "launch.mjs");
  const pids = path.join(folder, "pids");
  fs.writeFileSync(
    entryPath,
    `import { spawn } from "node:child_process";
import fs from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
fs.writeFileSync(${JSON.stringify(pids)}, process.pid + " " + child.pid);
setInterval(() => {}, 1000);
`,
  );
  fs.writeFileSync(
    launcher,
    `import { spawn } from "node:child_process";
spawn(process.execPath, [${JSON.stringify(entryPath)}, "doctor"], { detached: true, stdio: "ignore" }).unref();
`,
  );
  execFileSync(process.execPath, [launcher]);
  await waitFor(
    () => fs.existsSync(pids) && fs.readFileSync(pids, "utf8"),
    "fake Doctor",
  );
  const [doctor, grandchild] = fs.readFileSync(pids, "utf8").split(" ").map(Number);
  t.after(() => {
    try {
      process.kill(-doctor, "SIGKILL");
    } catch {
      /* Already gone. */
    }
  });
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const owner = ownerRecord(doctor, { nodePath: process.execPath, entryPath });
  return { owner, pids: [doctor, grandchild], alive };
}

test("recovery after a crash stops a Doctor left running before restoring", async (t) => {
  const candidate = { version: "2026.10.7", nodeVersion: "26.12.1" };
  const { readJSON } = await import("../../server/lib/storage.js");
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-live-doctor-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const doctor = await liveDoctor(t, folder);
  const f = await activationFixture(t, {
    candidate,
    // The process crashes while Doctor runs: the activation never continues.
    migrate: (paths, { onSpawn }) => {
      const agent = path.join(paths.state, "agents", "ap-1", "agent");
      fs.mkdirSync(agent, { recursive: true });
      for (const name of [
        "x.sqlite.pre-startup-migration-1.bak",
        "x.sqlite.pre-startup-migration-1.bak-wal",
      ])
        fs.writeFileSync(path.join(agent, name), "plain copy");
      fs.writeFileSync(path.join(paths.state, "history"), "half migrated");
      fs.mkdirSync(path.join(paths.root, "state.update-captures", "doctor-1"), {
        recursive: true,
      });
      onSpawn(doctor.owner);
      return new Promise(() => {});
    },
  });
  f.updates.activate();
  await waitFor(() => readJSON(f.journal).doctor, "recorded Doctor");
  assert.deepEqual(readJSON(f.journal).doctor, doctor.owner);
  assert.equal(doctor.pids.every(doctor.alive), true);
  const started = [];
  f.options.runtime.start = async () => {
    // Nothing of Doctor's group survives into the restored runtime's start.
    started.push(doctor.pids.some(doctor.alive));
    f.options.runtime.running = true;
  };
  const recovered = new f.RuntimeUpdates(f.options);
  assert.equal(recovered.status().recoveryRequired, true);
  await recovered.recover();
  assert.deepEqual(started, [false]);
  assert.deepEqual(readJSON(f.selection), f.previous);
  assert.equal(fs.readFileSync(path.join(f.paths.state, "history"), "utf8"), "before");
  assert.equal(fs.existsSync(path.join(f.paths.state, "agents", "ap-1")), false);
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
