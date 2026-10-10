import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { runtimePaths } from "../../server/features/assistants/runtime-paths.js";
import { acquireInstallLock } from "../../server/features/assistants/runtime-install-lock.js";
import { processIdentity } from "../../server/lib/process-identity.js";

function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "assistant-install-lock-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const paths = runtimePaths(dataDir);
  return { paths, lock: path.join(paths.runtimes, ".install.lock") };
}
async function deadPid() {
  const gone = spawn(process.execPath, ["-e", ""]);
  await once(gone, "exit");
  return gone.pid;
}

test("an unreadable lock is live while fresh and reclaimed once old", (t) => {
  const { paths, lock } = fixture(t);
  fs.writeFileSync(lock, "");
  assert.throws(() => acquireInstallLock(paths), { code: "RUNTIME_BUSY" });
  assert.equal(fs.readFileSync(lock, "utf8"), "");
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(lock, old, old);
  const release = acquireInstallLock(paths);
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, process.pid);
  release();
  assert.equal(fs.existsSync(lock), false);
  assert.deepEqual(fs.readdirSync(paths.runtimes), []);
});

test("a reclaim never removes a fresh lock that replaced the stale one", async (t) => {
  const { paths, lock } = fixture(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: await deadPid(), startTime: "gone" }));
  const other = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  t.after(() => other.kill("SIGKILL"));
  await once(other, "spawn");
  const fresh = JSON.stringify({
    pid: other.pid,
    startTime: processIdentity(other.pid).startTime,
  });
  // Another process reclaims the stale lock and takes the slot between our check
  // and our rename.
  const rename = fs.renameSync;
  let raced = false;
  t.mock.method(fs, "renameSync", (source, destination) => {
    if (!raced && source === lock) {
      raced = true;
      fs.rmSync(lock);
      fs.writeFileSync(lock, fresh);
    }
    return rename(source, destination);
  });
  assert.throws(() => acquireInstallLock(paths), { code: "RUNTIME_BUSY" });
  assert.equal(raced, true);
  assert.equal(fs.readFileSync(lock, "utf8"), fresh);
  assert.deepEqual(fs.readdirSync(paths.runtimes), [".install.lock"]);
});

test("after a stale lock only one of two contenders holds the slot", async (t) => {
  const { paths, lock } = fixture(t);
  fs.writeFileSync(lock, JSON.stringify({ pid: await deadPid(), startTime: "gone" }));
  const release = acquireInstallLock(paths);
  const held = fs.readFileSync(lock, "utf8");
  assert.throws(() => acquireInstallLock(paths), { code: "RUNTIME_BUSY" });
  assert.equal(fs.readFileSync(lock, "utf8"), held);
  release();
});
