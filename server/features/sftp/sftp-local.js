import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { projectTarget } from "../assistants/project-paths.js";
import { fold } from "../assistants/team-plugin/tool-guard.js";
import { sftpProblem } from "./sftp-errors.js";
import { defaultExcludes, excluded } from "./sftp-excludes.js";
import { sftpLimits } from "./sftp-limits.js";

const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const unsafe = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\\]/;
const refused = () => sftpProblem("SFTP_PATH_REFUSED");
const conflict = () => sftpProblem("SFTP_TYPE_CONFLICT");
const inside = (parent, child) =>
  child === parent ||
  child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

function realOrSelf(file) {
  try {
    return fs.realpathSync.native(file);
  } catch {
    return file;
  }
}

async function lstatOrNull(file) {
  try {
    return await fs.promises.lstat(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function relativeParts(relative) {
  if (typeof relative !== "string" || relative.length > sftpLimits.pathChars)
    throw refused();
  const parts = relative.split("/");
  if (unsafe.test(relative) || parts.some((p) => !p || p === "." || p === ".."))
    throw refused();
  return parts;
}

// Paths a transfer resolves against: the target folder, or the folder holding a
// target file (whose entry is then its own name).
function baseRelative(target) {
  const stat = fs.lstatSync(target.real, { throwIfNoEntry: false });
  if (!stat?.isFile()) return target.relative;
  const parent = path.posix.dirname(target.relative);
  return parent === "." ? "" : parent;
}

/**
 * The local side of a transfer, with the project-folder rules (`projectTarget`):
 * no links out, never `.git`, never AgentPier's data directory, and with `write`
 * never the run worktrees or, for restricted users, tool configuration. The rules
 * travel with the target so every file below it is checked the same way.
 */
export function localRoot({
  root,
  raw,
  write = false,
  protectedRoots = [],
  lockToolConfig = false,
}) {
  const target = projectTarget(root, raw, { write, protectedRoots, lockToolConfig });
  return Object.defineProperty(target, "rules", {
    value: Object.freeze({ write, protectedRoots: [...protectedRoots], lockToolConfig }),
  });
}

function scanGuard(limits) {
  const started = Date.now();
  let scanned = 0;
  return () => {
    if (++scanned > limits.maxScanEntries) throw sftpProblem("SFTP_LIMIT");
    if (Date.now() - started > limits.scanMs) throw sftpProblem("SFTP_TIMEOUT");
  };
}

const entryOf = (relative, stat) => ({
  path: relative,
  size: stat.size,
  mtimeMs: stat.mtimeMs,
});

/**
 * Lists the regular files below the target without following links. Links, files
 * with more than one link (a hard link may share an inode outside the folder) and
 * special files are counted as skipped; `.git`, excludes and protected roots are left
 * out. A target file lists itself under its name.
 */
export async function walkLocal(
  target,
  { excludes = defaultExcludes, limits = sftpLimits } = {},
) {
  const skipped = { links: 0, special: 0 };
  const entries = [];
  const stat = await fs.promises.lstat(target.real);
  if (stat.isFile()) {
    const name = path.basename(target.real);
    if (stat.nlink > 1) skipped.links++;
    else if (!excluded(name, excludes)) entries.push(entryOf(name, stat));
    return { entries, skipped };
  }
  if (!stat.isDirectory()) throw conflict();
  const guarded = (target.rules?.protectedRoots || []).map(realOrSelf);
  const tick = scanGuard(limits);
  const pending = [""];
  while (pending.length) {
    const relative = pending.pop();
    const directory = path.join(target.real, relative);
    for (const name of await fs.promises.readdir(directory)) {
      tick();
      const child = relative ? `${relative}/${name}` : name;
      const full = path.join(directory, name);
      if (
        fold(name) === ".git" ||
        excluded(child, excludes) ||
        guarded.some((root) => inside(root, full))
      )
        continue;
      const info = await lstatOrNull(full);
      if (!info) continue;
      if (info.isSymbolicLink()) skipped.links++;
      else if (info.isDirectory()) pending.push(child);
      else if (!info.isFile()) skipped.special++;
      else if (info.nlink > 1) skipped.links++;
      else entries.push(entryOf(child, info));
    }
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { entries, skipped };
}

/**
 * Opens a walked file for reading: the rules are checked again, no link may sit on
 * the way, and the opened file must be regular with a single link.
 */
export async function openLocalSource(target, relative) {
  const parts = [...baseRelative(target).split("/"), ...relativeParts(relative)].filter(
    Boolean,
  );
  const expected = path.join(target.root, ...parts);
  const resolved = projectTarget(target.root, parts.join("/"), {
    ...target.rules,
    write: false,
  });
  if (resolved.real !== expected || !resolved.exists) throw refused();
  let handle;
  try {
    handle = await fs.promises.open(expected, O_RDONLY | O_NOFOLLOW);
  } catch (error) {
    if (error.code === "ELOOP") throw refused();
    throw error;
  }
  try {
    const stat = await handle.stat();
    const parent = path.dirname(expected);
    if (!stat.isFile() || stat.nlink !== 1 || realOrSelf(parent) !== parent)
      throw refused();
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function ensureDirectory(directory) {
  let stat = await lstatOrNull(directory);
  if (!stat) {
    try {
      await fs.promises.mkdir(directory);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    stat = await fs.promises.lstat(directory);
  }
  if (stat.isSymbolicLink()) throw refused();
  if (!stat.isDirectory()) throw conflict();
}

async function copyInto(readable, handle, signal) {
  signal?.throwIfAborted();
  const abort = () => readable.destroy(signal.reason);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of readable) await handle.write(chunk);
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

/**
 * Writes `readable` to `relative` below a writable target: the rules are checked for
 * the file, parents are created one name at a time and never through a link, the
 * data lands in an exclusive `.<name>.agentpier-part-<hex>` file that is renamed into
 * place, and the temporary file is removed on any error or abort.
 */
export async function writeLocal(target, relative, readable, { mtimeMs, signal } = {}) {
  if (!target.rules?.write) throw refused();
  const parts = [...target.relative.split("/"), ...relativeParts(relative)].filter(
    Boolean,
  );
  projectTarget(target.root, parts.join("/"), target.rules);
  let directory = target.root;
  for (const name of parts.slice(0, -1)) {
    directory = path.join(directory, name);
    await ensureDirectory(directory);
  }
  const name = parts.at(-1);
  const destination = path.join(directory, name);
  const existing = await lstatOrNull(destination);
  if (existing?.isDirectory()) throw conflict();
  if (existing && !existing.isFile()) throw refused();
  const temporary = path.join(
    directory,
    `.${name}.agentpier-part-${randomBytes(8).toString("hex")}`,
  );
  const handle = await fs.promises.open(
    temporary,
    O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW,
    0o666,
  );
  try {
    await copyInto(readable, handle, signal);
    if (mtimeMs !== undefined && mtimeMs !== null)
      await handle.utimes(new Date(), new Date(mtimeMs));
    await handle.close();
    if (realOrSelf(directory) !== directory) throw refused();
    await fs.promises.rename(temporary, destination);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.promises.rm(temporary, { force: true });
    throw error;
  }
  return { overwritten: Boolean(existing) };
}
