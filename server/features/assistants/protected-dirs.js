import fs from "node:fs";
import path from "node:path";
import { assistantProblem } from "./assistant-validation.js";

// AgentPier's protected roots (its data directory) recognised by device and inode,
// not by their spelling: a path string misses the same folder in another case on a
// file system that ignores case, or through a macOS firmlink such as
// /System/Volumes/Data, which realpath does not resolve. Every agent-facing reader
// and writer compares each folder it walks with these identities
// (agent-share-source.js `refuseDirs`, project-paths.js, the recursive walks of
// project-files.js and sftp-local.js, the mail sources and saves, artifact
// publication, SSH key imports and the MCP sandbox grants of cli-grants.js).

const refused = () => assistantProblem("projectPathRefused", 403);
// The macOS data volume, under which every folder of the user's data is reachable a
// second time (firmlinks), with the same device and inode.
const dataVolume = "/System/Volumes/Data";
const logged = new Set();

// One line per cause, never the path: a fail-closed refusal stays diagnosable.
function unavailable(error) {
  const code = typeof error?.code === "string" ? error.code : "UNKNOWN";
  if (logged.has(code)) return;
  logged.add(code);
  console.warn(
    `A protected folder could not be identified (PROTECTED_ROOT_UNAVAILABLE, ${code}); access near it is refused.`,
  );
}

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
    } catch (error) {
      unavailable(error);
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

/** Whether `absolute` is or lies below one of `dirs` (assertOutsideDirs). */
export function insideDirs(absolute, dirs) {
  try {
    assertOutsideDirs(absolute, dirs, () => new Error("protected"));
    return false;
  } catch {
    return true;
  }
}

// The real path of `root` and, on macOS, its firmlink spelling when that names the
// same folder: the folders above either spelling hold the root.
function spellings(real) {
  const firmlinked = dataVolume + real;
  if (process.platform !== "darwin" || real.startsWith(dataVolume + path.sep))
    return [real];
  try {
    const a = fs.statSync(real, { bigint: true });
    const b = fs.statSync(firmlinked, { bigint: true });
    return a.dev === b.dev && a.ino === b.ino ? [real, firmlinked] : [real];
  } catch {
    return [real];
  }
}

/**
 * The identities of every folder from the file system root down to each protected
 * root, the root excluded, through every spelling of it (also the macOS data volume
 * /System/Volumes/Data and its parents): a write to one of them would replace a
 * folder that holds AgentPier's data. Throws `refuse()` like protectedDirs.
 */
export function protectedAncestors(roots, refuse = refused) {
  const dirs = [];
  for (const root of roots) {
    let real;
    try {
      real = fs.realpathSync.native(root);
    } catch (error) {
      unavailable(error);
      throw refuse();
    }
    for (const spelled of spellings(real))
      for (let dir = path.dirname(spelled); ; dir = path.dirname(dir)) {
        try {
          const stat = fs.statSync(dir, { bigint: true });
          dirs.push({ dev: stat.dev, ino: stat.ino });
        } catch (error) {
          unavailable(error);
          throw refuse();
        }
        if (dir === path.dirname(dir)) break;
      }
  }
  return dirs;
}

/**
 * The roots a write must also stay out of: the installed application
 * (AGENTPIER_INSTALL_ROOT, set by the launcher of an installed release), whose code
 * runs with the owner's rights. A source checkout sets none, so a project granted at
 * the checkout keeps working.
 */
export function writeProtectedRoots() {
  const root = process.env.AGENTPIER_INSTALL_ROOT;
  return root && path.isAbsolute(root) ? [root] : [];
}
