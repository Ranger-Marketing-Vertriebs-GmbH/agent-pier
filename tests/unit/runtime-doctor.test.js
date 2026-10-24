import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import {
  migrateRuntimeState,
  removeMigrationLeftovers,
} from "../../server/features/assistants/runtime-doctor.js";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { runtimeEnvironment } from "../../server/features/assistants/runtime-config.js";

const runtime = { nodePath: "/opt/node/bin/node", entryPath: "/opt/app/openclaw.mjs" };
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-doctor-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return runtimePaths(dataDir);
}
// A fake Doctor leading its own process group: `exit` decides how it ends, or it
// never ends until its group is killed. Its pid can never exist on macOS or Linux,
// and every signal goes to the fake `kill`, never to a real process.
const fakePid = 4242424;
function fakeSpawn(exit, { pid = fakePid, lingering = false } = {}) {
  const calls = [];
  const signals = [];
  let child;
  let group = false;
  const kill = (target, signal) => {
    signals.push([target, signal]);
    if (!group) throw Object.assign(Error("no such group"), { code: "ESRCH" });
    if (signal === "SIGKILL") {
      group = false;
      if (!child.exited) setImmediate(() => child.emit("exit", null, "SIGKILL"));
    }
    return true;
  };
  const spawn = (command, args, options) => {
    child = new EventEmitter();
    child.pid = pid;
    group = !!pid;
    child.once("exit", () => {
      child.exited = true;
      // A grandchild may keep the group alive after Doctor itself exited.
      if (!lingering) group = false;
    });
    calls.push({ command, args, options, child });
    fs.writeSync(options.stdio[1], "doctor output\n");
    if (exit) setImmediate(() => exit(child));
    return child;
  };
  const identity = () => ({ startTime: "fake start" });
  return { spawn, calls, kill, signals, identity, options: { spawn, kill, identity } };
}
const leftovers = (paths) => {
  const agent = path.join(paths.state, "agents", "ap-1", "agent");
  const shared = path.join(paths.state, "state");
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(shared, { recursive: true });
  const captures = path.join(paths.root, "state.update-captures");
  fs.mkdirSync(path.join(captures, "doctor-1", "payload"), { recursive: true });
  fs.writeFileSync(path.join(captures, "doctor-1", "payload", "2"), "{}");
  const files = {
    agentBackup: path.join(agent, "openclaw-agent.sqlite.pre-startup-migration-a1.bak"),
    agentBackupWal: path.join(
      agent,
      "openclaw-agent.sqlite.pre-startup-migration-a1.bak-wal",
    ),
    stateBackup: path.join(shared, "openclaw.sqlite.pre-startup-migration-a1.bak"),
    agentDb: path.join(agent, "openclaw-agent.sqlite"),
    stateDb: path.join(shared, "openclaw.sqlite"),
    configBackup: path.join(paths.state, "openclaw.json.bak"),
    other: path.join(agent, "notes.bak"),
  };
  for (const file of Object.values(files)) fs.writeFileSync(file, "x");
  return { ...files, captures };
};

test("Doctor runs non-interactively in the runtime's private environment", async (t) => {
  const paths = fixture(t);
  const fake = fakeSpawn((child) => child.emit("exit", 0, null));
  const { calls } = fake;
  const env = { PATH: "/usr/bin", HOME: "/Users/owner", SECRET: "kept-out" };
  const owners = [];
  await migrateRuntimeState(paths, runtime, {
    ...fake.options,
    env,
    onSpawn: (owner) => owners.push(owner),
  });
  assert.equal(calls.length, 1);
  const [{ command, args, options }] = calls;
  assert.equal(command, runtime.nodePath);
  assert.deepEqual(args, [runtime.entryPath, "doctor", "--fix", "--non-interactive"]);
  assert.equal(options.cwd, paths.root);
  assert.deepEqual(options.env, {
    ...runtimeEnvironment(paths, runtime.nodePath, env),
    OPENCLAW_SERVICE_REPAIR_POLICY: "external",
  });
  assert.equal(options.stdio[0], "ignore");
  assert.equal(options.stdio[1], options.stdio[2]);
  // Its own process group, recorded before it is awaited.
  assert.equal(options.detached, true);
  assert.equal(owners.length, 1);
  assert.equal(owners[0].pid, fakePid);
  assert.equal(owners[0].startTime, "fake start");
  assert.equal(owners[0].entryPath, runtime.entryPath);
  const log = path.join(paths.logs, "gateway-console.log");
  assert.equal(fs.readFileSync(log, "utf8"), "doctor output\n");
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
});

test("a successful Doctor run removes its own backups and update captures", async (t) => {
  const paths = fixture(t);
  const files = leftovers(paths);
  const fake = fakeSpawn((child) => child.emit("exit", 0, null));
  await migrateRuntimeState(paths, runtime, { ...fake.options, env: {} });
  assert.equal(fs.existsSync(files.agentBackup), false);
  assert.equal(fs.existsSync(files.agentBackupWal), false);
  assert.equal(fs.existsSync(files.stateBackup), false);
  assert.equal(fs.existsSync(files.captures), false);
  for (const kept of ["agentDb", "stateDb", "configBackup", "other"])
    assert.equal(fs.existsSync(files[kept]), true, kept);
});

test("a non-zero exit rejects with UPDATE_MIGRATION_FAILED", async (t) => {
  const paths = fixture(t);
  const files = leftovers(paths);
  const fake = fakeSpawn((child) => child.emit("exit", 78, null));
  await assert.rejects(
    migrateRuntimeState(paths, runtime, { ...fake.options, env: {} }),
    {
      code: "UPDATE_MIGRATION_FAILED",
      status: 500,
    },
  );
  // Its captures lie outside every restored tree; they never outlive a failure.
  assert.equal(fs.existsSync(files.captures), false);
});

test("a signal or a spawn error rejects with UPDATE_MIGRATION_FAILED", async (t) => {
  const paths = fixture(t);
  const signal = fakeSpawn((child) => child.emit("exit", null, "SIGTERM"));
  await assert.rejects(
    migrateRuntimeState(paths, runtime, { ...signal.options, env: {} }),
    {
      code: "UPDATE_MIGRATION_FAILED",
    },
  );
  // Never spawned: no pid, no group to kill.
  const missing = fakeSpawn(
    (child) => child.emit("error", Object.assign(Error("spawn"), { code: "ENOENT" })),
    { pid: null },
  );
  await assert.rejects(
    migrateRuntimeState(paths, runtime, { ...missing.options, env: {} }),
    {
      code: "UPDATE_MIGRATION_FAILED",
    },
  );
  assert.deepEqual(missing.signals, []);
});

test("an error from a live Doctor kills its group and waits for its exit", async (t) => {
  const paths = fixture(t);
  let exited = false;
  const fake = fakeSpawn((child) => {
    child.once("exit", () => (exited = true));
    child.emit("error", Error("kill failed"));
  });
  await assert.rejects(
    migrateRuntimeState(paths, runtime, { ...fake.options, env: {} }),
    {
      code: "UPDATE_MIGRATION_FAILED",
    },
  );
  assert.equal(exited, true);
  assert.deepEqual(fake.signals[0], [-fakePid, "SIGKILL"]);
});

test("a Doctor that never exits has its group killed after the timeout", async (t) => {
  const paths = fixture(t);
  const fake = fakeSpawn(null);
  const started = Date.now();
  await assert.rejects(
    migrateRuntimeState(paths, runtime, { ...fake.options, env: {}, timeoutMs: 50 }),
    { code: "UPDATE_MIGRATION_FAILED" },
  );
  assert.ok(Date.now() - started >= 45);
  assert.deepEqual(fake.signals[0], [-fakePid, "SIGKILL"]);
});

test("a process Doctor left behind is killed before the migration resolves", async (t) => {
  const paths = fixture(t);
  const fake = fakeSpawn((child) => child.emit("exit", 0, null), { lingering: true });
  await migrateRuntimeState(paths, runtime, { ...fake.options, env: {} });
  assert.deepEqual(fake.signals[0], [-fakePid, "SIGKILL"]);
  assert.throws(() => fake.kill(-fakePid, 0), { code: "ESRCH" });
});

test("an unrecorded Doctor is killed and fails the migration", async (t) => {
  const paths = fixture(t);
  const fake = fakeSpawn(null);
  const onSpawn = () => {
    throw Error("journal not writable");
  };
  await assert.rejects(
    migrateRuntimeState(paths, runtime, { ...fake.options, env: {}, onSpawn }),
    { code: "UPDATE_MIGRATION_FAILED" },
  );
  assert.deepEqual(fake.signals[0], [-fakePid, "SIGKILL"]);
});

test("an unsafe console log fails the migration and still cleans up", async (t) => {
  const paths = fixture(t);
  const files = leftovers(paths);
  fs.symlinkSync("/dev/null", path.join(paths.logs, "gateway-console.log"));
  const fake = fakeSpawn((child) => child.emit("exit", 0, null));
  await assert.rejects(
    migrateRuntimeState(paths, runtime, { ...fake.options, env: {} }),
    {
      code: "UPDATE_MIGRATION_FAILED",
    },
  );
  assert.equal(fake.calls.length, 0);
  assert.equal(fs.existsSync(files.captures), false);
});

test("leftover removal never follows links", async (t) => {
  const paths = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-doctor-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const victim = path.join(outside, "openclaw.sqlite.pre-startup-migration-a1.bak");
  fs.writeFileSync(victim, "x");
  fs.writeFileSync(path.join(outside, "keep"), "x");
  // A linked agent folder, a linked backup name and a linked captures folder.
  fs.mkdirSync(path.join(paths.state, "agents", "ap-2"), { recursive: true });
  fs.symlinkSync(outside, path.join(paths.state, "agents", "ap-2", "agent"));
  fs.symlinkSync(outside, path.join(paths.state, "state"));
  fs.symlinkSync(outside, path.join(paths.root, "state.update-captures"));
  removeMigrationLeftovers(paths);
  assert.equal(fs.existsSync(victim), true);
  assert.equal(fs.existsSync(path.join(outside, "keep")), true);
  assert.equal(fs.existsSync(path.join(paths.root, "state.update-captures")), false);
});

test("leftover removal tolerates a state folder without agents", (t) => {
  const paths = fixture(t);
  assert.doesNotThrow(() => removeMigrationLeftovers(paths));
});
