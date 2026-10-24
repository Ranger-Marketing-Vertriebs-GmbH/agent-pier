import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GuardedRuntimeSupervisor, guardProcess } from "../helpers/process-guard.js";

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
// A detached leader that ignores SIGTERM, with a child in its group that does too.
const stubborn = `const { spawn } = require("node:child_process");
process.on("SIGTERM", () => {});
const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(child.pid);
setInterval(() => {}, 1000);`;

let pids = [];
test("a guarded process group is gone once its test ends", async (t) => {
  await t.test("starts it", async (st) => {
    const leader = spawn(process.execPath, ["-e", stubborn], {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    guardProcess(st, leader, { group: true, graceMs: 200 });
    const [line] = await once(leader.stdout, "data");
    pids = [leader.pid, Number(String(line).trim())];
    assert.ok(pids.every(alive));
  });
  // Both ignored SIGTERM; the guard's SIGKILL took the whole group.
  for (let tries = 0; tries < 40 && pids.some(alive); tries++)
    await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(pids.map(alive), [false, false]);
});

test("a guarded child that exited is never signalled again", async () => {
  const { guardedCount } = await import("../helpers/process-guard.js");
  const before = guardedCount();
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  guardProcess(null, child);
  assert.equal(guardedCount(), before + 1);
  await once(child, "exit");
  // Its pid may belong to another process by the time the test process exits.
  assert.equal(guardedCount(), before);
});

// A Gateway stand-in whose IPC child outlives it: like OpenClaw 2026.10.7's SQLite
// read children, it exits only once it sees the disconnect and writes on its way out
// (Node's compile cache), after the Gateway itself is gone.
const lingering = (marker) => `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", ${JSON.stringify(
  `process.on("disconnect", () => setTimeout(() => { require("node:fs").writeFileSync(${JSON.stringify(marker)}, "late"); process.exit(0); }, 400)); setInterval(() => {}, 1000);`,
)}], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
console.log(child.pid);
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);`;

test("stopping a guarded Gateway waits for the children it leaves behind", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "process-guard-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const marker = path.join(dataDir, "late-write");
  const runtime = new GuardedRuntimeSupervisor({ dataDir, install: async () => ({}) });
  const gateway = spawn(process.execPath, ["-e", lingering(marker)], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  guardProcess(t, gateway);
  const [line] = await once(gateway.stdout, "data");
  const child = Number(String(line).trim());
  guardProcess(t, child);
  runtime.child = gateway;
  await runtime.terminateOwnedChild(2000);
  assert.equal(alive(child), false, "the Gateway's child has exited");
  assert.equal(fs.readFileSync(marker, "utf8"), "late");
});
