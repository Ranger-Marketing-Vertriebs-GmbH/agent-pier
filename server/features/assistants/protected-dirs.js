import fs from "node:fs";
import path from "node:path";
import { assistantProblem } from "./assistant-validation.js";

// AgentPier's protected roots (its data directory) recognised by device and inode,
// not by their spelling: a path string misses the same folder in another case on a
// file system that ignores case, or through a macOS firmlink such as
// /System/Volumes/Data, which realpath does not resolve. Every agent-facing reader
// and writer compares each folder it walks with these identities
// (agent-share-source.js `refuseDirs`, project-paths.js, the recursive walks of
// project-files.js and sftp-local.js, the mail sources and saves).

const refused = () => assistantProblem("projectPathRefused", 403);

/**
 * The identities `{ dev, ino }` (bigints) of `roots`, links resolved. A root whose
 * identity cannot be determined (missing, unreadable) throws `refuse()`: nothing is
 * admitted that might lie below it.
 */
export function protectedDirs(roots, refuse = refused) {
  return roots.map((root) => {
    try {
      const stat = fs.statSync(root, { bigint: true });
      return { dev: stat.dev, ino: stat.ino };
    } catch {
      throw refuse();
    }
  });
}

/** Whether a folder's stat (bigint) is one of `dirs` (protectedDirs). */
export const sameDir = (dirs, stat) =>
  dirs.some((d) => d.dev === stat.dev && d.ino === stat.ino);

/**
 * Refuses (`refuse()`) when a folder from the file system root down to `absolute`,
 * itself included, is one of `dirs`, each looked at without following a link.
 * Names below the deepest existing folder end the walk (a folder created later is
 * new, never a protected root); a folder on the way that cannot be looked at
 * refuses.
 */
export function assertOutsideDirs(absolute, dirs, refuse = refused) {
  if (!dirs.length) return;
  let current = path.parse(absolute).root;
  for (const part of ["", ...absolute.slice(current.length).split(path.sep)]) {
    if (part) current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current, { bigint: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw refuse();
    }
    if (sameDir(dirs, stat)) throw refuse();
  }
}

/**
 * The identities of every folder from the file system root down to each protected
 * root, the root excluded: a write to one of them would replace a folder that holds
 * AgentPier's data, whatever its spelling. Throws `refuse()` like protectedDirs.
 */
export function protectedAncestors(roots, refuse = refused) {
  const dirs = [];
  for (const root of roots) {
    let real;
    try {
      real = fs.realpathSync.native(root);
    } catch {
      throw refuse();
    }
    for (let dir = path.dirname(real); ; dir = path.dirname(dir)) {
      try {
        const stat = fs.statSync(dir, { bigint: true });
        dirs.push({ dev: stat.dev, ino: stat.ino });
      } catch {
        throw refuse();
      }
      if (dir === path.dirname(dir)) break;
    }
  }
  return dirs;
}
