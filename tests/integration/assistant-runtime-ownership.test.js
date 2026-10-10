import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import { RuntimeSupervisor } from "../../server/features/assistants/runtime-supervisor.js";
import { recordOwner } from "../../server/features/assistants/gateway-ownership.js";
import { processIdentity } from "../../server/lib/process-identity.js";

function fixture(t, prefix, source = "setInterval(() => {}, 1000)") {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const entryPath = path.join(dataDir, "gateway.mjs");
  fs.writeFileSync(entryPath, source);
  const runtime = { nodePath: process.execPath, entryPath, version: "fixture" };
  return { dataDir, entryPath, runtime };
}
const readyClient = () =>
  Object.assign(new EventEmitter(), {
    ready: false,
    async connect() {
      this.ready = true;
    },
    close() {
      this.ready = false;
    },
  });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function orphan(t, entryPath) {
  const child = spawn(process.execPath, [entryPath, "gateway", "run"], {
    stdio: "ignore",
  });
  t.after(() => child.kill("SIGKILL"));
  await once(child, "spawn");
  // Let a SIGTERM-ignoring fixture install its handler before the supervisor signals it.
  await new Promise((r) => setTimeout(r, 200));
  return child;
}
const ownerFile = (dataDir) => path.join(dataDir, "assistants", "owner.json");
function supervisor(t, dataDir, runtime, options = {}) {
  const value = new RuntimeSupervisor({
    dataDir,
    install: async () => runtime,
    clientFactory: readyClient,
    ...options,
  });
  t.after(() => value.close());
  return value;
}

test("owner record identifies the Gateway by pid, start time, executable and entry", async (t) => {
  const { dataDir, entryPath, runtime } = fixture(t, "assistant-owner-record-");
  const runtimeSupervisor = supervisor(t, dataDir, runtime);
  await runtimeSupervisor.start();
  const owner = JSON.parse(fs.readFileSync(ownerFile(dataDir), "utf8"));
  const pid = runtimeSupervisor.child.pid;
  assert.equal(owner.pid, pid);
  assert.equal(owner.startTime, processIdentity(pid).startTime);
  assert.equal(owner.executable, fs.realpathSync(process.execPath));
  assert.equal(owner.entryPath, entryPath);
  assert.equal(fs.statSync(ownerFile(dataDir)).mode & 0o777, 0o600);
});

test("a stale owner whose process is gone is cleared and startup proceeds", async (t) => {
  const { dataDir, entryPath, runtime } = fixture(t, "assistant-owner-stale-");
  const gone = spawn(process.execPath, ["-e", ""]);
  await once(gone, "exit");
  fs.mkdirSync(path.dirname(ownerFile(dataDir)), { recursive: true });
  fs.writeFileSync(
    ownerFile(dataDir),
    JSON.stringify({ pid: gone.pid, startTime: "x", executable: "x", entryPath }),
  );
  const runtimeSupervisor = supervisor(t, dataDir, runtime);
  await runtimeSupervisor.start();
  assert.equal(runtimeSupervisor.status().availability, "ready");
});

test("our orphaned Gateway is terminated before a new one starts", async (t) => {
  const { dataDir, entryPath, runtime } = fixture(t, "assistant-owner-orphan-");
  const previous = await orphan(t, entryPath);
  const exited = once(previous, "exit");
  recordOwner(ownerFile(dataDir), previous.pid, runtime);
  const runtimeSupervisor = supervisor(t, dataDir, runtime);
  await runtimeSupervisor.start();
  const [, signal] = await exited;
  assert.equal(signal, "SIGTERM");
  assert.notEqual(runtimeSupervisor.child.pid, previous.pid);
  assert.equal(runtimeSupervisor.status().availability, "ready");
});

test("an orphan showing OpenClaw's process title is still recognized as ours", async (t) => {
  const { dataDir, entryPath, runtime } = fixture(
    t,
    "assistant-owner-titled-",
    "process.title = 'openclaw-gateway'; setInterval(() => {}, 1000)",
  );
  const previous = await orphan(t, entryPath);
  const exited = once(previous, "exit");
  assert.equal(processIdentity(previous.pid).command.includes(entryPath), false);
  recordOwner(ownerFile(dataDir), previous.pid, runtime);
  const runtimeSupervisor = supervisor(t, dataDir, runtime);
  await runtimeSupervisor.start();
  const [, signal] = await exited;
  assert.equal(signal, "SIGTERM");
});

test("an orphan that ignores SIGTERM is killed after the grace period", async (t) => {
  const { dataDir, entryPath, runtime } = fixture(
    t,
    "assistant-owner-stubborn-",
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
  );
  const previous = await orphan(t, entryPath);
  const exited = once(previous, "exit");
  recordOwner(ownerFile(dataDir), previous.pid, runtime);
  const runtimeSupervisor = supervisor(t, dataDir, runtime, {
    timing: { killGraceMs: 300 },
  });
  await runtimeSupervisor.start();
  const [, signal] = await exited;
  assert.equal(signal, "SIGKILL");
  assert.equal(runtimeSupervisor.status().availability, "ready");
});

test("a live process with another identity is a conflict and is never signalled", async (t) => {
  const { dataDir, runtime } = fixture(t, "assistant-owner-foreign-");
  const other = path.join(dataDir, "other.mjs");
  fs.writeFileSync(other, "setInterval(() => {}, 1000)");
  const foreign = await orphan(t, other);
  // Same start time and executable, but argv names another program.
  recordOwner(ownerFile(dataDir), foreign.pid, runtime);
  const runtimeSupervisor = supervisor(t, dataDir, runtime, {
    install: () => assert.fail("should not install"),
  });
  await assert.rejects(runtimeSupervisor.start(), { code: "OWNERSHIP_CONFLICT" });
  await assert.rejects(runtimeSupervisor.assertStopped(), { code: "OWNERSHIP_CONFLICT" });
  assert.equal(alive(foreign.pid), true);
  assert.equal(foreign.signalCode, null);
});

test("a reused pid with another start time is stale and is never signalled", async (t) => {
  const { dataDir, entryPath, runtime } = fixture(t, "assistant-owner-reused-");
  const reused = await orphan(t, entryPath);
  recordOwner(ownerFile(dataDir), reused.pid, runtime);
  const owner = JSON.parse(fs.readFileSync(ownerFile(dataDir), "utf8"));
  fs.writeFileSync(
    ownerFile(dataDir),
    JSON.stringify({ ...owner, startTime: `${owner.startTime}-earlier` }),
  );
  const runtimeSupervisor = supervisor(t, dataDir, runtime);
  await runtimeSupervisor.start();
  assert.equal(alive(reused.pid), true);
  assert.notEqual(runtimeSupervisor.child.pid, reused.pid);
});

test(
  "a process owned by another user (EPERM) is a conflict",
  { skip: process.getuid?.() === 0 },
  async (t) => {
    const { dataDir, entryPath, runtime } = fixture(t, "assistant-owner-eperm-");
    fs.mkdirSync(path.dirname(ownerFile(dataDir)), { recursive: true });
    fs.writeFileSync(
      ownerFile(dataDir),
      JSON.stringify({
        pid: 1,
        startTime: "any",
        executable: fs.realpathSync(process.execPath),
        entryPath,
      }),
    );
    const runtimeSupervisor = supervisor(t, dataDir, runtime, {
      install: () => assert.fail("should not install"),
    });
    await assert.rejects(runtimeSupervisor.start(), { code: "OWNERSHIP_CONFLICT" });
  },
);

test("the update stop check reclaims our own orphaned Gateway", async (t) => {
  const { dataDir, entryPath, runtime } = fixture(t, "assistant-owner-update-");
  const previous = await orphan(t, entryPath);
  const exited = once(previous, "exit");
  recordOwner(ownerFile(dataDir), previous.pid, runtime);
  const runtimeSupervisor = supervisor(t, dataDir, runtime);
  await runtimeSupervisor.assertStopped();
  const [, signal] = await exited;
  assert.equal(signal, "SIGTERM");
  assert.equal(fs.existsSync(ownerFile(dataDir)), false);
});
