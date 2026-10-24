import fs from "node:fs";
import path from "node:path";
import { spawn as spawnProcess } from "node:child_process";
import { runtimeEnvironment } from "./runtime-config.js";
import { openConsoleLog } from "./gateway-log.js";

const failure = (code, status = 503) => Object.assign(Error(code), { code, status });
// OpenClaw's pre-migration database copies beside each agent and state database.
const doctorBackup = /\.pre-startup-migration-[^/]+\.bak$/;

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

/**
 * Migrates the stopped runtime's state with OpenClaw's own Doctor. From 2026.10.6 the
 * Gateway refuses an agent database of an older schema (24 → 25 needs stopped-writer
 * maintenance), so the candidate's Doctor runs before its first start. It never
 * prompts, and never repairs services or launchd jobs. Output goes to the Gateway's
 * console log; the exit code alone decides (Node's warnings land on stderr too).
 */
export async function migrateRuntimeState(
  paths,
  runtime,
  { spawn = spawnProcess, timeoutMs = 600000, env = process.env } = {},
) {
  const log = openConsoleLog(path.join(paths.logs, "gateway-console.log"));
  let outcome;
  try {
    outcome = await new Promise((resolve) => {
      let child, timer;
      const settle = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
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
          },
        );
      } catch {
        return settle(false);
      } finally {
        fs.closeSync(log);
      }
      let timedOut = false;
      child.once("error", () => settle(false));
      // A killed Doctor is waited for: rollback must not race its last writes.
      child.once("exit", (code) => settle(!timedOut && code === 0));
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    });
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
