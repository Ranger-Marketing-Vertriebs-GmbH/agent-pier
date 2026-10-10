import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { processIdentity } from "../../lib/process-identity.js";

// An unreadable lock is only stale once nobody can still be creating it.
const unreadableGraceMs = 30000;
const busy = () =>
  Object.assign(Error("Another process is installing the assistant runtime."), {
    code: "RUNTIME_BUSY",
    status: 409,
  });
function holder(lock) {
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    // EPERM: another user's live process; never treated as stale.
    return error.code === "ESRCH" ? "stale" : "live";
  }
  try {
    return processIdentity(lock.pid).startTime === lock.startTime ? "live" : "stale";
  } catch {
    return "live";
  }
}
function stale(text, mtimeMs) {
  let lock;
  try {
    lock = JSON.parse(text);
  } catch {
    lock = null;
  }
  if (!Number.isSafeInteger(lock?.pid) || lock.pid <= 0)
    return Date.now() - mtimeMs > unreadableGraceMs;
  return holder(lock) === "stale";
}
const missing = (error) => {
  if (error.code !== "ENOENT") throw error;
  return null;
};
/**
 * Moves a stale lock aside and removes it only if the moved file is still the one
 * judged stale; a lock another process created meanwhile is put back untouched.
 * Returns true when the slot may be retried.
 */
function reclaim(file) {
  let text, stat;
  try {
    text = fs.readFileSync(file, "utf8");
    stat = fs.statSync(file);
  } catch (error) {
    return missing(error) === null;
  }
  if (!stale(text, stat.mtimeMs)) return false;
  const moved = `${file}.reclaim-${randomUUID()}`;
  try {
    fs.renameSync(file, moved);
  } catch (error) {
    return missing(error) === null;
  }
  try {
    if (fs.readFileSync(moved, "utf8") === text) return true;
    try {
      fs.linkSync(moved, file);
    } catch {
      /* A newer lock already holds the slot. */
    }
    return false;
  } finally {
    fs.rmSync(moved, { force: true });
  }
}
/**
 * Cross-process installation lock naming the holder's pid and start time. The
 * complete record is linked into place, so no reader ever sees a partial lock.
 */
export function acquireInstallLock(paths, identity = processIdentity) {
  const file = path.join(paths.runtimes, ".install.lock");
  const record = JSON.stringify({
    pid: process.pid,
    startTime: identity(process.pid).startTime,
    nonce: randomUUID(),
  });
  const temporary = `${file}.${randomUUID()}`;
  fs.writeFileSync(temporary, record, { mode: 0o600, flag: "wx" });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.linkSync(temporary, file);
        return () => {
          try {
            if (fs.readFileSync(file, "utf8") === record) fs.rmSync(file);
          } catch {
            /* Already removed. */
          }
        };
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
      if (!reclaim(file)) throw busy();
    }
    throw busy();
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
export async function withInstallLock(paths, operation) {
  const release = acquireInstallLock(paths);
  try {
    return await operation();
  } finally {
    release();
  }
}
