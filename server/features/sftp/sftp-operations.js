import path from "node:path";
import { sftpProblem } from "./sftp-errors.js";
import { SftpGate } from "./sftp-gate.js";
import { sftpLimits } from "./sftp-limits.js";
import {
  confineRemote,
  insideRoot,
  remotePath,
  unsafeName,
} from "./sftp-remote-paths.js";

const posix = path.posix;
const iso = (mtimeMs) => new Date(mtimeMs).toISOString();
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** A name a server listed that never becomes part of a path (`/`, `.`, controls). */
export function badName(name) {
  return (
    typeof name !== "string" ||
    !name ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    unsafeName.test(name)
  );
}

/** `name` below the absolute remote folder `dir`. */
export function joinRemote(dir, name) {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/**
 * Confines the entry `abs` without following its last name: its folder is resolved
 * and confined to `root`, the name is joined unresolved. A link is then handled as a
 * link (deleted, refused) and never followed.
 */
export async function confineEntry(session, abs, root) {
  const normal = remotePath(abs);
  if (normal === "/") throw sftpProblem("SFTP_PATH_REFUSED");
  const parent = await confineRemote(session, posix.dirname(normal), root ?? "/");
  return joinRemote(parent, posix.basename(normal));
}

/** The folder's entries sorted by name, at most `limit` (`truncated` if more). */
export async function sftpList(session, abs, { limit = sftpLimits.listEntries } = {}) {
  const listed = (await session.readdir(abs)).filter(({ name }) => !badName(name));
  listed.sort(byName);
  return {
    path: abs,
    entries: listed.slice(0, limit).map(({ name, type, size, mtimeMs }) => ({
      name,
      type,
      size,
      mtime: iso(mtimeMs),
    })),
    truncated: listed.length > limit,
  };
}

/** The entry itself (a link is reported as a link); `SFTP_NOT_FOUND` if missing. */
export async function sftpStat(session, abs) {
  const stat = await session.lstat(abs);
  if (!stat) throw sftpProblem("SFTP_NOT_FOUND");
  return { path: abs, type: stat.type, size: stat.size, mtime: iso(stat.mtimeMs) };
}

/**
 * Creates the folder; with `parents` also its missing ancestors. An existing folder
 * is fine (`created: false`); anything else in the way is `SFTP_TYPE_CONFLICT`.
 */
export async function sftpMkdir(session, abs, { parents = false } = {}) {
  const chain = [];
  for (let dir = abs; dir !== "/"; dir = posix.dirname(dir)) chain.unshift(dir);
  const steps = parents ? chain : chain.slice(-1);
  let created = false;
  for (const dir of steps) {
    const stat = await session.lstat(dir);
    if (stat && stat.type !== "dir") throw sftpProblem("SFTP_TYPE_CONFLICT");
    if (stat) continue;
    await session.mkdir(dir);
    created = true;
  }
  return { path: abs, created };
}

/** Renames `from` to `to`; never replaces an existing `to` (`SFTP_TYPE_CONFLICT`). */
export async function sftpRename(session, from, to) {
  if (!(await session.lstat(from))) throw sftpProblem("SFTP_NOT_FOUND");
  if (await session.lstat(to)) throw sftpProblem("SFTP_TYPE_CONFLICT");
  await session.rename(from, to);
  return { from, to };
}

const needsRoot = (root) => {
  if (typeof root !== "string" || !root.startsWith("/"))
    throw new TypeError("An SFTP delete needs its allowed remote folder or /.");
};

/**
 * What deleting `abs` removes. The target is confined to `root` (required: the
 * host's allowed remote folder, or `/` for none) first (its folder
 * resolved, its own name not followed): the allowed folder itself, `/` and anything
 * outside are refused before anything is listed. Without `recursive` only a file, a
 * link or an empty folder (a non-empty one is `SFTP_TYPE_CONFLICT`); with it the
 * whole folder, its links deleted as links and never followed. Files are sorted,
 * folders listed deepest first.
 */
export async function planDelete(
  session,
  abs,
  { recursive = false, limits = sftpLimits, root } = {},
) {
  needsRoot(root);
  const target = await confineEntry(session, abs, root);
  const stat = await session.lstat(target);
  if (!stat) throw sftpProblem("SFTP_NOT_FOUND");
  const plan = { path: target, recursive, files: [], dirs: [], bytes: 0 };
  if (stat.type !== "dir") {
    plan.files.push(target);
    plan.bytes = stat.type === "file" ? stat.size : 0;
    return plan;
  }
  const started = Date.now();
  let scanned = 0;
  const pending = [target];
  while (pending.length) {
    const dir = pending.pop();
    plan.dirs.push(dir);
    const listed = await session.readdir(dir);
    if (listed.length && !recursive) throw sftpProblem("SFTP_TYPE_CONFLICT");
    for (const entry of listed) {
      if (++scanned > limits.maxScanEntries) throw sftpProblem("SFTP_LIMIT");
      if (Date.now() - started > limits.scanMs) throw sftpProblem("SFTP_TIMEOUT");
      // A name that cannot be addressed safely would leave its folder behind.
      if (badName(entry.name)) throw sftpProblem("SFTP_PATH_REFUSED");
      const child = joinRemote(dir, entry.name);
      if (entry.type === "dir") pending.push(child);
      else {
        plan.files.push(child);
        if (entry.type === "file") plan.bytes += entry.size;
      }
    }
    if (plan.files.length > limits.maxFiles) throw sftpProblem("SFTP_LIMIT");
  }
  plan.files.sort();
  plan.dirs.sort((a, b) => b.split("/").length - a.split("/").length || (a < b ? 1 : -1));
  return plan;
}

const sameList = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Runs an approved delete plan. The plan is computed again (confined to the required
 * `root`) and
 * must match, else `SFTP_PLAN_CHANGED` and nothing is deleted; every path must lie in
 * the plan's target and is confined again; files go first, then folders deepest
 * first. Stops at the first error; `signal` cancels, and `stillAuthorized` is
 * awaited before each step and every 2 s (false or an error revokes). Returns
 * `{ state, files, dirs, code?, failedPath?, durationMs }` like `runTransfer`.
 */
export async function runDelete(
  session,
  deletePlan,
  {
    signal,
    onProgress,
    stillAuthorized,
    root,
    limits = sftpLimits,
    authorizeEveryMs,
  } = {},
) {
  needsRoot(root);
  const started = Date.now();
  const gate = new SftpGate({ signal, stillAuthorized, everyMs: authorizeEveryMs });
  const result = { state: "completed", files: 0, dirs: 0 };
  let current = null;
  try {
    await gate.check();
    const target = remotePath(deletePlan.path);
    const fresh = await planDelete(session, target, {
      recursive: Boolean(deletePlan.recursive),
      limits,
      root,
    });
    if (
      fresh.path !== target ||
      !sameList(fresh.files, deletePlan.files) ||
      !sameList(fresh.dirs, deletePlan.dirs)
    )
      throw sftpProblem("SFTP_PLAN_CHANGED");
    const steps = [
      ...fresh.files.map((p) => [p, false]),
      ...fresh.dirs.map((p) => [p, true]),
    ];
    for (const [raw, directory] of steps) {
      await gate.check();
      current = remotePath(raw);
      if (!insideRoot(target, current)) throw sftpProblem("SFTP_PATH_REFUSED");
      const abs = await confineEntry(session, current, root);
      if (directory) {
        await session.rmdir(abs);
        result.dirs++;
      } else {
        await session.unlink(abs);
        result.files++;
      }
      onProgress?.({ files: result.files, dirs: result.dirs, current });
      current = null;
    }
  } catch (error) {
    Object.assign(result, gate.outcome(error));
    if (current) result.failedPath = current;
  } finally {
    gate.close();
  }
  result.durationMs = Date.now() - started;
  return result;
}
