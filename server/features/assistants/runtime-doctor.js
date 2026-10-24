import fs from "node:fs";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { runtimeEnvironment } from "./runtime-config.js";
import { setTimeout as delay } from "node:timers/promises";
import { openConsoleLog } from "./gateway-log.js";
import { inspectOwner, ownerRecord, ownershipConflict } from "./gateway-ownership.js";
import { processIdentity } from "../../lib/process-identity.js";

const failure = (code, status = 503) => Object.assign(Error(code), { code, status });
// OpenClaw's pre-migration database copies beside each agent and state database.
const doctorBackup = /\.pre-startup-migration-[^/]+\.bak(-wal|-shm|-journal)?$/;

function realFolder(folder) {
  const stat = fs.lstatSync(folder, { throwIfNoEntry: false });
  return !!stat && stat.isDirectory() && !stat.isSymbolicLink();
}
function removeBackups(folder) {
  if (!realFolder(folder)) return;
  for (const name of fs.readdirSync(folder))
    if (doctorBackup.test(name)) {
      const file = path.join(folder, name);
      const stat = fs.lstatSync(file);
      // A link is removed itself, never its target.
      if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(file);
    }
}

/**
 * Removes what OpenClaw's Doctor keeps for its own manual recovery: the
 * `*.pre-startup-migration-*.bak` copy of each database it migrated and the
 * `state.update-captures/` folder beside `state/`. Both hold private data and
 * credentials in plain form; the activation's sealed snapshot already covers a
 * rollback. Links are removed, never followed.
 */
export function removeMigrationLeftovers(paths) {
  const agents = path.join(paths.state, "agents");
  if (realFolder(agents))
    for (const id of fs.readdirSync(agents)) {
      if (realFolder(path.join(agents, id)))
        removeBackups(path.join(agents, id, "agent"));
    }
  removeBackups(path.join(paths.state, "state"));
  fs.rmSync(path.join(paths.root, "state.update-captures"), {
    recursive: true,
    force: true,
  });
}

const groupKill = (kill) => (pid, name) => {
  try {
    kill(-pid, name);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw ownershipConflict();
  }
};
// From event handlers: a failure here surfaces in the final killGroup instead.
const tryKill = (kill, pid) => {
  try {
    groupKill(kill)(pid, "SIGKILL");
  } catch {
    /* Reported by killGroup. */
  }
};
/** Kills process group `pid` and waits until none of its members is left. */
async function killGroup(pid, { kill, graceMs = 5000 }) {
  const signal = groupKill(kill);
  signal(pid, "SIGKILL");
  for (const end = Date.now() + graceMs; Date.now() < end; await delay(50))
    if (!signal(pid, 0)) return;
  if (signal(pid, 0)) throw ownershipConflict();
}

/**
 * Stops a Doctor an earlier AgentPier process left running (`owner` from the update
 * journal), with every process of its group, before a rollback restores state under
 * it. Its own process, or its group after it exited, is killed; a pid that now
 * belongs to another process is left alone (a live group keeps its id from reuse).
 */
export async function stopDoctor(
  owner,
  { identity = processIdentity, kill = process.kill, graceMs } = {},
) {
  if (!owner?.pid) return;
  const state = inspectOwner(owner, identity);
  if (state === "conflict") throw ownershipConflict();
  let reused = false;
  try {
    kill(owner.pid, 0);
    reused = state === "stale";
  } catch {
    // The leader is gone; members of its group may still run.
  }
  if (!reused) await killGroup(owner.pid, { kill, graceMs });
}

/**
 * Migrates the stopped runtime's state with OpenClaw's own Doctor. From 2026.10.6 the
 * Gateway refuses an agent database of an older schema (24 → 25 needs stopped-writer
 * maintenance), so the candidate's Doctor runs before its first start. It never
 * prompts, and never repairs services or launchd jobs. Output goes to the Gateway's
 * console log; the exit code alone decides (Node's warnings land on stderr too).
 * Doctor leads its own process group, which `onSpawn` records (ownerRecord) so a
 * later process can stop it (stopDoctor); every end kills what is left of the group.
 */
export async function migrateRuntimeState(
  paths,
  runtime,
  {
    spawn = spawnProcess,
    timeoutMs = 600000,
    env = process.env,
    identity = processIdentity,
    kill = process.kill,
    onSpawn = () => {},
  } = {},
) {
  let outcome = false;
  try {
    const log = openConsoleLog(path.join(paths.logs, "gateway-console.log"));
    let child;
    try {
      child = spawn(
        runtime.nodePath,
        [runtime.entryPath, "doctor", "--fix", "--non-interactive"],
        {
          cwd: paths.root,
          env: {
            ...runtimeEnvironment(paths, runtime.nodePath, env),
            OPENCLAW_SERVICE_REPAIR_POLICY: "external",
          },
          stdio: ["ignore", log, log],
          detached: true,
        },
      );
    } finally {
      fs.closeSync(log);
    }
    const ended = new Promise((resolve) => {
      child.once("exit", (code) => resolve(code === 0));
      // Without a pid it never started; otherwise its exit is still awaited.
      child.once("error", () => {
        if (!child.pid) resolve(false);
        else tryKill(kill, child.pid);
      });
    });
    // Recorded before it is awaited; an unrecorded Doctor is not let run.
    let recorded = true;
    try {
      if (child.pid) onSpawn(ownerRecord(child.pid, runtime, identity));
    } catch {
      recorded = false;
      tryKill(kill, child.pid);
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      tryKill(kill, child.pid);
    }, timeoutMs);
    try {
      outcome = (await ended) && !timedOut && recorded;
    } finally {
      clearTimeout(timer);
    }
    // A process Doctor started must not outlive it and write under a rollback.
    if (child.pid) await killGroup(child.pid, { kill });
  } catch {
    outcome = false;
  } finally {
    try {
      removeMigrationLeftovers(paths);
    } catch {
      // Plain copies that cannot be removed fail the migration; rollback retries.
      outcome = false;
    }
  }
  if (!outcome) throw failure("UPDATE_MIGRATION_FAILED", 500);
}
