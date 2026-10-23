import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fold } from "../assistants/team-plugin/tool-guard.js";
import { sftpProblem } from "./sftp-errors.js";
import { excludeList, excluded, isPartFile } from "./sftp-excludes.js";
import { sftpLimits } from "./sftp-limits.js";
import { caseInsensitiveTarget, openLocalSource, walkLocal } from "./sftp-local.js";
import { badName, confineEntry, joinRemote } from "./sftp-operations.js";
import { capPlan, pathKey, planSummary, planTransfer } from "./sftp-plan.js";
import { confineRemote, remotePath } from "./sftp-remote-paths.js";

const posix = path.posix;
const DIRECTIONS = { download: ["down"], upload: ["up"], sync: ["up", "down"] };
const emptySide = () => ({
  entries: [],
  dirs: [],
  kept: new Set(),
  skipped: { links: 0, special: 0, unsafe: 0 },
});

function scanGuard(limits, signal) {
  const started = Date.now();
  let scanned = 0;
  return () => {
    signal?.throwIfAborted();
    if (++scanned > limits.maxScanEntries) throw sftpProblem("SFTP_LIMIT");
    if (Date.now() - started > limits.scanMs) throw sftpProblem("SFTP_TIMEOUT");
  };
}

/**
 * Lists the regular files below the remote folder `base` like `walkLocal`: links are
 * never followed and, like special files and names no path may carry, counted as
 * skipped; `.git`, `.agentpier-part-` files and excludes are left out.
 */
export async function walkRemote(session, base, { excludes, limits, signal }) {
  const side = emptySide();
  const keep = (relative) => {
    for (let dir = relative; dir && dir !== "." && !side.kept.has(dir);) {
      side.kept.add(dir);
      dir = posix.dirname(dir);
    }
  };
  const tick = scanGuard(limits, signal);
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop();
    const listed = await session.readdir(relative ? joinRemote(base, relative) : base);
    for (const { name, type, size, mtimeMs } of listed) {
      tick();
      if (badName(name)) {
        side.skipped.unsafe++;
        keep(relative);
        continue;
      }
      const child = relative ? `${relative}/${name}` : name;
      if (isPartFile(name) || fold(name) === ".git" || excluded(child, excludes)) {
        keep(relative);
      } else if (type === "dir") {
        side.dirs.push(child);
        pending.push(child);
      } else if (type === "file") {
        side.entries.push({ path: child, size, mtimeMs });
      } else {
        keep(relative);
        side.skipped[type === "link" ? "links" : "special"]++;
      }
    }
  }
  side.entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  side.dirs.sort();
  return side;
}

async function hashStream(readable, signal) {
  const hash = createHash("sha256");
  for await (const chunk of readable) {
    signal?.throwIfAborted();
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function checkedRequest(request) {
  const { operation, direction, local } = request || {};
  if (!DIRECTIONS[operation]?.includes(direction))
    throw new TypeError("Invalid SFTP transfer request.");
  if (!local?.root || !local.rules) throw new TypeError("Invalid SFTP local target.");
  if (direction === "down" && !local.rules.write) throw sftpProblem("SFTP_PATH_REFUSED");
  if (typeof request.remotePath !== "string" || !request.remotePath.startsWith("/"))
    throw sftpProblem("SFTP_PATH_REFUSED");
  const remoteRoot =
    request.remoteRoot === null || request.remoteRoot === undefined
      ? null
      : remotePath(request.remoteRoot);
  return {
    remote: remotePath(request.remotePath),
    remoteRoot,
    excludes: excludeList(request.excludes ?? [], {
      defaults: request.defaultExcludes !== false,
    }),
    sync: operation === "sync",
  };
}

function localStat(local) {
  return fs.lstatSync(local.real, { throwIfNoEntry: false }) || null;
}

const typeOfLocal = (stat) =>
  !stat ? null : stat.isFile() ? "file" : stat.isDirectory() ? "dir" : "other";

/**
 * Where a transfer reads and writes, per relative plan path: the remote path below
 * the confined remote base, and the name below the local target. A file transfer
 * plans its one file under the target's name.
 */
function transferLayout({ kind, base, local, root }) {
  const file = kind === "file";
  return {
    kind,
    base,
    root,
    remoteOf: (relative) => (file ? base : remotePath(relative, base)),
    localOf: (relative) => (file ? path.basename(local.real) : relative),
  };
}

async function remoteBase(session, remote, root) {
  // The folder or file itself may be a link the owner set up (a web root); resolve
  // and confine it once. Below it, links are never followed.
  const resolved = await confineRemote(session, remote, root ?? "/");
  const stat = await session.lstat(resolved);
  if (stat && stat.type !== "file" && stat.type !== "dir")
    throw sftpProblem("SFTP_TYPE_CONFLICT");
  return { path: resolved, type: stat?.type ?? null, stat };
}

async function sides(session, request, checked, limits, signal) {
  const { local, direction } = request;
  const up = direction === "up";
  const remote = await remoteBase(session, checked.remote, checked.remoteRoot);
  const localType = typeOfLocal(localStat(local));
  if (localType === "other") throw sftpProblem("SFTP_TYPE_CONFLICT");
  const sourceType = up ? localType : remote.type;
  const targetType = up ? remote.type : localType;
  if (!sourceType) throw sftpProblem("SFTP_NOT_FOUND");
  const kind = sourceType === "file" ? "file" : "folder";
  if (targetType && targetType !== sourceType)
    throw Object.assign(sftpProblem("SFTP_TYPE_CONFLICT"), {
      details: { path: kind === "file" ? posix.basename(remote.path) : "" },
    });
  const options = { excludes: checked.excludes, limits, signal };
  const base = remote.path;
  // A file transfer plans its one file under the target's name.
  const name = posix.basename(up ? base : local.real);
  const named = (entries) => entries.map((entry) => ({ ...entry, path: name }));
  const walkLocalSide = async () => {
    if (!localType) return emptySide();
    const walked = await walkLocal(local, options);
    return kind === "file" ? { ...walked, entries: named(walked.entries) } : walked;
  };
  const walkRemoteSide = async () => {
    if (!remote.type) return emptySide();
    if (kind === "folder") return walkRemote(session, base, options);
    const side = emptySide();
    if (up || !excluded(posix.basename(base), checked.excludes))
      side.entries = named([
        { path: name, size: remote.stat.size, mtimeMs: remote.stat.mtimeMs },
      ]);
    return side;
  };
  const [localSide, remoteSide] = [await walkLocalSide(), await walkRemoteSide()];
  return {
    kind,
    base,
    source: up ? localSide : remoteSide,
    target: up ? remoteSide : localSide,
  };
}

// Hashes the same-size pairs only: a size difference already marks a change.
async function pairHashes(session, layout, request, scanned, foldCase, signal) {
  const hashes = { source: new Map(), target: new Map() };
  const targets = new Map();
  for (const entry of scanned.target.entries) {
    const key = pathKey(entry.path, { foldCase });
    if (!targets.has(key) || entry.path === targets.get(key).path)
      targets.set(key, entry);
  }
  const up = request.direction === "up";
  const readLocal = async (relative) => {
    const handle = await openLocalSource(request.local, relative);
    try {
      return await hashStream(handle.createReadStream({ autoClose: false }), signal);
    } finally {
      await handle.close();
    }
  };
  const readRemote = async (relative) =>
    hashStream(
      session.readStream(
        await confineEntry(session, layout.remoteOf(relative), layout.root),
      ),
      signal,
    );
  for (const entry of scanned.source.entries) {
    const other = targets.get(pathKey(entry.path, { foldCase }));
    if (!other || other.size !== entry.size) continue;
    hashes.source.set(
      entry.path,
      up ? await readLocal(layout.localOf(entry.path)) : await readRemote(entry.path),
    );
    hashes.target.set(
      other.path,
      up ? await readRemote(other.path) : await readLocal(layout.localOf(other.path)),
    );
  }
  return hashes;
}

// Target folders a sync with deletes removes: absent from the source, holding nothing
// it keeps, deepest first.
function extraFolders(scanned, foldCase) {
  const sourceDirs = new Set(scanned.source.dirs.map((d) => pathKey(d, { foldCase })));
  return scanned.target.dirs
    .filter((dir) => !sourceDirs.has(pathKey(dir, { foldCase })))
    .filter((dir) => !scanned.target.kept.has(dir))
    .sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1));
}

/**
 * Pre-scans both sides of a transfer within the scan caps, plans it (`planTransfer`
 * with the transfer's context, `foldCase` when the local side is the target) and
 * refuses it over the file and byte caps before anything is written or approved.
 */
export async function prepareTransfer(
  session,
  request,
  { limits = sftpLimits, signal } = {},
) {
  const checked = checkedRequest(request);
  const scanned = await sides(session, request, checked, limits, signal);
  const { kind, base } = scanned;
  const local = request.local;
  const layout = transferLayout({ kind, base, local, root: checked.remoteRoot });
  const foldCase = request.direction === "down" ? caseInsensitiveTarget(local) : false;
  const deleteExtra = checked.sync && kind === "folder" && Boolean(request.deleteExtra);
  const hashes = request.checksum
    ? await pairHashes(session, layout, request, scanned, foldCase, signal)
    : null;
  const deleteDirs = deleteExtra ? extraFolders(scanned, foldCase) : [];
  const plan = planTransfer({
    source: scanned.source.entries,
    target: scanned.target.entries,
    sync: checked.sync,
    deleteExtra,
    hashes,
    foldCase,
    context: {
      operation: request.operation,
      direction: request.direction,
      kind,
      hostId: request.hostId ?? null,
      hostRevision: request.hostRevision ?? null,
      projectId: request.projectId ?? null,
      remoteRoot: checked.remoteRoot,
      remotePath: base,
      localRoot: local.root,
      localPath: local.relative,
      excludes: checked.excludes,
      deleteDirs,
    },
  });
  plan.deleteDirs = deleteDirs;
  capPlan(plan, limits);
  const summary = {
    ...planSummary(plan, limits.planListLimit),
    operation: request.operation,
    direction: request.direction,
    kind,
    remotePath: base,
    deleteDirs: deleteDirs.slice(0, limits.planListLimit),
  };
  const prepared = {
    request,
    kind,
    plan,
    summary,
    skipped: { ...scanned.source.skipped },
  };
  // Execution re-plans and uses its own layout; this one never leaves the process.
  return Object.defineProperty(prepared, "layout", { value: layout });
}
