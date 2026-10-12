import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { atomic, folder, readJson } from "./files.js";

/**
 * Backups, inspections, uploads and restores create work files: snapshot folders,
 * unfinished archives, uploads and restore stages. Several processes can use one
 * data directory (the server and `scripts/operations.mjs`), so each work file is
 * claimed by its process before it is created, and only the server removes work
 * left behind, once at its start, when the claiming process is gone.
 */
const startedAt = Math.round(Date.now() - process.uptime() * 1000);
export const currentOwner = Object.freeze({ pid: process.pid, startedAt });
const claimsFolder = (dataDir) => path.join(dataDir, "operations", "work");

/** The start time `ps` reports for `pid` in ms, or null when it cannot tell. */
function processStart(pid) {
  try {
    const text = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    const time = Date.parse(`${text} UTC`);
    return Number.isFinite(time) ? time : null;
  } catch {
    return null;
  }
}
/**
 * Whether the process that claimed work still runs. A reused process id is told
 * apart by its start time; when that cannot be read, the owner counts as alive.
 */
export function ownerAlive(owner) {
  if (!Number.isSafeInteger(owner?.pid) || owner.pid <= 0) return false;
  if (owner.pid === process.pid) return owner.startedAt === startedAt;
  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
  }
  const actual = processStart(owner.pid);
  // ps reports whole seconds.
  return actual === null || Math.abs(actual - owner.startedAt) < 2000;
}

/**
 * Claims `target` (a file or folder about to be created) for this process.
 * Returns a release function that forgets the claim (not the target).
 */
export function claim(dataDir, target) {
  const file = path.join(folder(claimsFolder(dataDir)), `${randomUUID()}.json`);
  atomic(file, { target: path.resolve(target), ...currentOwner });
  return () => fs.rmSync(file, { force: true });
}

function claims(dataDir) {
  const directory = claimsFolder(dataDir);
  if (!fs.existsSync(directory)) return [];
  return fs
    .readdirSync(directory)
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .map((name) => ({
      file: path.join(directory, name),
      ...readJson(path.join(directory, name), {}),
    }));
}
/** Targets a running process still works on; such targets are never removed. */
export function liveTargets(dataDir, { alive = ownerAlive } = {}) {
  return new Set(
    claims(dataDir)
      .filter((entry) => typeof entry.target === "string" && alive(entry))
      .map((entry) => entry.target),
  );
}

// What a work file may be named, so a claim can never remove anything else.
const workName =
  /^(?:\.snapshot-|\.inspect-|\.agentpier-restore-)[A-Za-z0-9-]+$|\.(?:tmp|upload|upload\.json)$/;

/**
 * Removes work of processes that are gone: claimed targets of dead owners, and
 * unclaimed work files in the operations folders (left by a crash before a claim
 * existed). Runs once when the server starts.
 */
export function removeAbandonedWork(dataDir, { alive = ownerAlive } = {}) {
  const live = liveTargets(dataDir, { alive });
  for (const entry of claims(dataDir)) {
    if (typeof entry.target === "string" && live.has(entry.target)) continue;
    if (typeof entry.target === "string" && workName.test(path.basename(entry.target)))
      fs.rmSync(entry.target, { recursive: true, force: true });
    fs.rmSync(entry.file, { force: true });
  }
  for (const relative of ["operations", "operations/backups", "operations/restores"]) {
    const directory = path.join(dataDir, relative);
    if (!fs.existsSync(directory)) continue;
    for (const name of fs.readdirSync(directory)) {
      const target = path.join(directory, name);
      // An upload's description belongs to its data file.
      const owner = name.endsWith(".upload.json") ? target.slice(0, -5) : target;
      if (workName.test(name) && !live.has(owner))
        fs.rmSync(target, { recursive: true, force: true });
    }
  }
}
