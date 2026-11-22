import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// The browser engine folders AgentPier names for Hermes agents (hermes-environment.js
// harnessRuntimeDir, `/tmp/aph-<12 hex>`, marked `agentpier.json` with the agent's
// HOME): ending the engine daemons one lists, and the start sweep of folders a process
// set left behind when AgentPier ended without stopping it.

const folderName = /^aph-[0-9a-f]{12}$/;
export const harnessMarker = "agentpier.json";

const commandOf = (pid) => {
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
      encoding: "utf8",
    });
  } catch {
    return "";
  }
};

/**
 * Ends the browser engine daemons that published their pid in `folder`: each runs in
 * a session of its own and outlives its process set (Hermes v0.23 ends its own,
 * v0.22.5 left them running). Only a process that is a browser-harness daemon is
 * signalled.
 */
export function endHarnessDaemons(
  folder,
  { kill = process.kill.bind(process), command = commandOf } = {},
) {
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".pid")) continue;
    let pid;
    try {
      pid = Number.parseInt(fs.readFileSync(path.join(folder, name), "utf8"), 10);
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(pid) || pid <= 1) continue;
    if (!/\bbrowser_harness\.daemon\b/.test(command(pid))) continue;
    for (const target of [-pid, pid])
      try {
        kill(target, "SIGTERM");
        break;
      } catch {
        /* Not a group of its own, or gone. */
      }
  }
}

// A folder of this user that no one else may enter, as AgentPier creates them.
function ownPrivate(dir) {
  try {
    const stat = fs.lstatSync(dir);
    return (
      stat.isDirectory() &&
      !stat.isSymbolicLink() &&
      stat.uid === process.getuid?.() &&
      (stat.mode & 0o777) === 0o700
    );
  } catch {
    return false;
  }
}

const within = (root, target) => {
  const relative = path.relative(root, target);
  return !!relative && !relative.startsWith("..") && !path.isAbsolute(relative);
};

/**
 * At AgentPier's start, before any Hermes agent of `dataDir` runs: removes each
 * engine folder below `root` that belongs to no running agent, after ending the
 * daemons it lists. A folder is AgentPier's (`aph-<12 hex>`, this user's, mode 0700)
 * and stale when its marker names a HOME of this data directory (none runs yet), a
 * HOME that no longer exists, or none at all. Another data directory's existing
 * agent may be running in another AgentPier and keeps its folder. Returns the folders
 * removed.
 */
export function sweepHarnessDirs({ dataDir, root = "/tmp", ...options }) {
  const homes = path.join(path.resolve(dataDir), "assistants", "hermes", "home");
  let names = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const removed = [];
  for (const name of names) {
    if (!folderName.test(name)) continue;
    const dir = path.join(root, name);
    if (!ownPrivate(dir)) continue;
    let home = null;
    try {
      home = JSON.parse(fs.readFileSync(path.join(dir, harnessMarker), "utf8"))?.home;
    } catch {
      /* No marker: stale. */
    }
    const stale =
      typeof home !== "string" ||
      within(homes, path.resolve(home)) ||
      !fs.existsSync(home);
    if (!stale) continue;
    endHarnessDaemons(dir, options);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      /* Left for the next start. */
    }
  }
  return removed;
}
