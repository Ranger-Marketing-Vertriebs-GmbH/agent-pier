import fs from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { readJSON, writePrivate } from "../../lib/storage.js";
import { processIdentity } from "../../lib/process-identity.js";

export const ownershipConflict = () =>
  Object.assign(Error("Assistant runtime ownership conflict."), {
    code: "OWNERSHIP_CONFLICT",
  });

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === "ESRCH") return false;
    // EPERM: another user's process; never ours to inspect or signal.
    throw ownershipConflict();
  }
}

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return null;
  }
}

export function recordOwner(file, pid, runtime, identity = processIdentity) {
  let startTime = null;
  try {
    startTime = identity(pid).startTime;
  } catch {
    // Without a start time the record stays unverifiable and fails closed later.
  }
  writePrivate(file, {
    pid,
    parentPid: process.pid,
    startTime,
    executable: realpath(runtime.nodePath),
    entryPath: runtime.entryPath,
  });
}

// "stale": the recorded process is gone (or its pid now belongs to a process that
// started at another time). "ours": same start time, same runtime executable, and
// either our entry path in argv or OpenClaw's own process title. Anything else,
// including an old record without identity, is a conflict.
export function inspectOwner(owner, identity = processIdentity) {
  if (!alive(owner.pid)) return "stale";
  if (!owner.startTime || !owner.executable || !owner.entryPath) return "conflict";
  let observed;
  try {
    observed = identity(owner.pid);
  } catch {
    return alive(owner.pid) ? "conflict" : "stale";
  }
  if (observed.startTime !== owner.startTime) return "stale";
  const command = observed.command;
  return observed.executable === owner.executable &&
    (command.includes(owner.entryPath) || /^openclaw(-gateway)?(\s|$)/.test(command))
    ? "ours"
    : "conflict";
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch (error) {
    if (error.code !== "ESRCH") throw ownershipConflict();
  }
}

async function exited(pid, timeoutMs) {
  for (const end = Date.now() + timeoutMs; Date.now() < end;) {
    if (!alive(pid)) return true;
    await delay(50);
  }
  return !alive(pid);
}

/** Clears a stale owner record or retires our own orphaned Gateway. */
export async function reclaimOwner(
  file,
  { identity = processIdentity, graceMs = 3000 } = {},
) {
  const owner = readJSON(file, null);
  if (!owner?.pid) return;
  const state = inspectOwner(owner, identity);
  if (state === "conflict") throw ownershipConflict();
  if (state === "ours") {
    signal(owner.pid, "SIGTERM");
    if (!(await exited(owner.pid, graceMs))) {
      if (inspectOwner(owner, identity) === "ours") signal(owner.pid, "SIGKILL");
      if (!(await exited(owner.pid, graceMs))) throw ownershipConflict();
    }
  }
  fs.rmSync(file, { force: true });
}
