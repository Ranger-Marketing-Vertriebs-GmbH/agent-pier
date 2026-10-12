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

// A claim this old is abandoned whatever its process id shows.
export const CLAIM_LIFETIME = 7 * 24 * 60 * 60 * 1000;
// Linux reports process start times in clock ticks; USER_HZ is 100 on every
// architecture Node supports.
const TICKS_PER_SECOND = 100;

/** Linux: the start time from /proc in ms, or null without /proc. */
export function procStart(pid, root = "/proc") {
  try {
    const stat = fs.readFileSync(path.join(root, String(pid), "stat"), "utf8");
    // The command name (field 2) may contain spaces; fields follow its ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = Number(fields[19]);
    const boot = /^btime (\d+)$/m.exec(fs.readFileSync(path.join(root, "stat"), "utf8"));
    if (!Number.isFinite(ticks) || !boot) return null;
    return Number(boot[1]) * 1000 + (ticks / TICKS_PER_SECOND) * 1000;
  } catch {
    return null;
  }
}
/** The start time `ps` reports for `pid` in ms, or null when it cannot tell. */
function psStart(pid) {
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
  const actual = psStart(owner.pid) ?? procStart(owner.pid);
  // ps reports whole seconds.
  return actual === null || Math.abs(actual - owner.startedAt) < 2000;
}

/**
 * Claims `target` (a file or folder about to be created) for this process.
 * Returns a release function that forgets the claim (not the target).
 */
export function claim(dataDir, target) {
  if (!claimable(dataDir, target)) throw new Error(`Not a backup work path: ${target}`);
  const file = path.join(folder(claimsFolder(dataDir)), `${randomUUID()}.json`);
  atomic(file, {
    target: path.resolve(target),
    ...currentOwner,
    claimedAt: Date.now(),
  });
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
const live = (entry, alive, now) => {
  const claimedAt = Number.isFinite(entry.claimedAt)
    ? entry.claimedAt
    : fs.statSync(entry.file).mtimeMs;
  return now - claimedAt <= CLAIM_LIFETIME && alive(entry);
};
/** Targets a running process still works on; such targets are never removed. */
export function liveTargets(dataDir, { alive = ownerAlive, now = Date.now() } = {}) {
  return new Set(
    claims(dataDir)
      .filter((entry) => typeof entry.target === "string" && live(entry, alive, now))
      .map((entry) => entry.target),
  );
}

// What work is named in each operations folder; only these are ever removed.
const workNames = {
  operations: /^\.snapshot-[A-Za-z0-9-]+$/,
  "operations/backups": /\.tmp$/,
  "operations/restores": /^\.inspect-[A-Za-z0-9-]+$|\.upload(?:\.json)?$/,
};
// A restore stage sits beside its target, wherever that is.
const stageName =
  /^\.agentpier-restore-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
/** Whether `target` is a path backup work may claim (and its cleanup remove). */
export function claimable(dataDir, target) {
  if (typeof target !== "string" || !path.isAbsolute(target)) return false;
  const resolved = path.resolve(target);
  if (stageName.test(path.basename(resolved))) return true;
  const relative = path.relative(path.resolve(dataDir), path.dirname(resolved));
  return Boolean(workNames[relative]?.test(path.basename(resolved)));
}

/**
 * Removes work of processes that are gone: claimed targets of dead owners, and
 * unclaimed work files in the operations folders (left by a crash before a claim
 * existed). Runs once when the server starts.
 */
export function removeAbandonedWork(
  dataDir,
  { alive = ownerAlive, now = Date.now() } = {},
) {
  const kept = liveTargets(dataDir, { alive, now });
  for (const entry of claims(dataDir)) {
    if (kept.has(entry.target)) continue;
    if (claimable(dataDir, entry.target))
      fs.rmSync(entry.target, { recursive: true, force: true });
    fs.rmSync(entry.file, { force: true });
  }
  for (const [relative, name] of Object.entries(workNames)) {
    const directory = path.join(dataDir, relative);
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory)) {
      const target = path.join(directory, entry);
      // An upload's description belongs to its data file.
      const owner = entry.endsWith(".upload.json") ? target.slice(0, -5) : target;
      if (name.test(entry) && !kept.has(owner))
        fs.rmSync(target, { recursive: true, force: true });
    }
  }
}
