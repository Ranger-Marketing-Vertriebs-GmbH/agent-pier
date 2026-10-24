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
// A fake child: `exit` decides how it ends, or it never ends until killed.
function fakeSpawn(exit) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.killed = [];
    child.kill = (signal) => {
      child.killed.push(signal);
      setImmediate(() => child.emit("exit", null, signal));
      return true;
    };
    calls.push({ command, args, options, child });
    fs.writeSync(options.stdio[1], "doctor output\n");
    if (exit) setImmediate(() => exit(child));
    return child;
  };
  return { spawn, calls };
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
  const { spawn, calls } = fakeSpawn((child) => child.emit("exit", 0, null));
  const env = { PATH: "/usr/bin", HOME: "/Users/owner", SECRET: "kept-out" };
  await migrateRuntimeState(paths, runtime, { spawn, env });
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
  const log = path.join(paths.logs, "gateway-console.log");
  assert.equal(fs.readFileSync(log, "utf8"), "doctor output\n");
  assert.equal(fs.statSync(log).mode & 0o777, 0o600);
});

test("a successful Doctor run removes its own backups and update captures", async (t) => {
  const paths = fixture(t);
  const files = leftovers(paths);
  const { spawn } = fakeSpawn((child) => child.emit("exit", 0, null));
  await migrateRuntimeState(paths, runtime, { spawn, env: {} });
  assert.equal(fs.existsSync(files.agentBackup), false);
  assert.equal(fs.existsSync(files.stateBackup), false);
  assert.equal(fs.existsSync(files.captures), false);
  for (const kept of ["agentDb", "stateDb", "configBackup", "other"])
    assert.equal(fs.existsSync(files[kept]), true, kept);
});

test("a non-zero exit rejects with UPDATE_MIGRATION_FAILED", async (t) => {
  const paths = fixture(t);
  const files = leftovers(paths);
  const { spawn } = fakeSpawn((child) => child.emit("exit", 78, null));
  await assert.rejects(migrateRuntimeState(paths, runtime, { spawn, env: {} }), {
    code: "UPDATE_MIGRATION_FAILED",
    status: 500,
  });
  // Its captures lie outside every restored tree; they never outlive a failure.
  assert.equal(fs.existsSync(files.captures), false);
});

test("a signal or a spawn error rejects with UPDATE_MIGRATION_FAILED", async (t) => {
  const paths = fixture(t);
  for (const exit of [
    (child) => child.emit("exit", null, "SIGTERM"),
    (child) => child.emit("error", Object.assign(Error("spawn"), { code: "ENOENT" })),
  ]) {
    const { spawn } = fakeSpawn(exit);
    await assert.rejects(migrateRuntimeState(paths, runtime, { spawn, env: {} }), {
      code: "UPDATE_MIGRATION_FAILED",
    });
  }
});

test("a Doctor that never exits is killed after the timeout and rejects", async (t) => {
  const paths = fixture(t);
  const { spawn, calls } = fakeSpawn(null);
  const started = Date.now();
  await assert.rejects(
    migrateRuntimeState(paths, runtime, { spawn, env: {}, timeoutMs: 50 }),
    { code: "UPDATE_MIGRATION_FAILED" },
  );
  assert.ok(Date.now() - started >= 45);
  assert.deepEqual(calls[0].child.killed, ["SIGKILL"]);
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
