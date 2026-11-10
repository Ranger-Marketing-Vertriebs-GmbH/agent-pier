import fs from "node:fs";
import path from "node:path";

// Where a command runs, as far as the default list needs it. `git` reads the
// configuration of the repository it stands in and `npm test` runs whatever that
// folder's package.json says, so both are answered without a card only inside the
// session's project: its folder, the Git work tree around it and the repository's
// other work trees, the main one with its `.worktrees/` (request-approvals.js names
// these roots). A place follows the `cd` parts of a chain and git's `-C`.
//
// Symbolic links are resolved, so a link inside the project does not lead out of
// it. A shell reads `link/..` as the folder that holds the link, `git -C` and a
// shell set to follow links read it as the parent of the link's target; a folder
// counts only when both readings agree. A path that is outside the project as
// written is refused without looking at the file system. Without a known folder a
// relative path that never goes up counts as inside.
//
// For git the folder must also belong to one of the project's own repositories
// (`ownRepository`).

/** The path with its existing part resolved through symbolic links. */
function real(target) {
  const rest = [];
  for (let current = target; ;) {
    try {
      return path.join(fs.realpathSync.native(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}
const exists = (target) => {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
};
/**
 * `dir` from the resolved folder `base`, following each link before the next part.
 * After the first part that does not exist nothing is looked up any more.
 */
function physical(base, dir) {
  let current = path.isAbsolute(dir) ? path.parse(dir).root : base,
    found = true;
  for (const part of dir.split(path.sep)) {
    if (part === "..") current = path.dirname(current);
    else if (part && part !== ".") {
      const next = path.join(current, part);
      found &&= exists(next);
      current = found ? real(next) : next;
    }
  }
  return current;
}
// Longer or deeper paths than any project uses are not resolved at all.
const maxPath = 1024;
const maxDepth = 40;
const absolute = (value) =>
  typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
const within = (root, target) =>
  target === root || target.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const inside = (roots, target) => roots.some((root) => within(root, target));

/**
 * The place a command starts in: the shell's folder `cwd` and the project's `roots`
 * (the folder itself when none are given). A place made here is returned as it is.
 */
export function startPlace(place) {
  if (place?.ready) return place;
  if (!absolute(place?.cwd)) return { ready: true, cwd: null, roots: [], strayed: false };
  const cwd = path.normalize(place.cwd);
  const given = (place.roots?.length ? place.roots : [cwd])
    .filter(absolute)
    .map((root) => path.normalize(root));
  const roots = given.map(real);
  // The folder as the shell names it, when that is another name for a project folder.
  const written = [
    ...new Set([...given, ...roots, ...(inside(roots, real(cwd)) ? [cwd] : [])]),
  ];
  return { ready: true, cwd, roots, written, strayed: false };
}

/**
 * The folder `dir` names from `place` when it lies in the project, else null. With
 * an unknown folder the result is a path relative to wherever the shell stands.
 */
export function folderIn(place, dir) {
  if (place.strayed || typeof dir !== "string" || !dir || dir.includes("\0")) return null;
  if (dir.length > maxPath || dir.split(path.sep).length > maxDepth) return null;
  if (place.cwd === null) {
    if (path.isAbsolute(dir)) return null;
    const relative = path.normalize(path.join(place.relative ?? ".", dir));
    return relative === ".." || relative.startsWith(`..${path.sep}`) ? null : relative;
  }
  const target = path.resolve(place.cwd, dir);
  if (!inside(place.written, target)) return null;
  const resolved = real(target);
  if (!inside(place.roots, resolved)) return null;
  return physical(real(place.cwd), dir) === resolved ? target : null;
}

/** Whether the place itself lies in the project. */
export const inProject = (place) => folderIn(place, ".") !== null;

/** The place after `cd dir`; after a `cd` out of the project nothing counts as inside. */
export function movedTo(place, dir) {
  const target = folderIn(place, dir);
  if (target === null) return { ...place, strayed: true };
  return place.cwd === null ? { ...place, relative: target } : { ...place, cwd: target };
}

const isFile = (target) => fs.statSync(target, { throwIfNoEntry: false })?.isFile();
const isFolder = (target) =>
  fs.statSync(target, { throwIfNoEntry: false })?.isDirectory();
/** A folder that is itself a Git directory, as a bare repository is. */
const bare = (dir) =>
  isFile(path.join(dir, "HEAD")) &&
  isFolder(path.join(dir, "objects")) &&
  isFolder(path.join(dir, "refs"));

/**
 * Whether the repository git finds from the place is one of the project's own. Git
 * walks up to the nearest `.git` entry; a nested repository, a submodule or a bare
 * repository on the way has its own configuration and asks. Where no repository
 * is found git only reports that.
 */
export function ownRepository(place) {
  if (place.strayed) return false;
  if (place.cwd === null) return true;
  try {
    for (let dir = real(place.cwd), depth = 0; ; depth++) {
      if (depth > maxDepth * 2 || bare(dir)) return false;
      if (exists(path.join(dir, ".git"))) return place.roots.includes(dir);
      const parent = path.dirname(dir);
      if (parent === dir) return true;
      dir = parent;
    }
  } catch {
    return false;
  }
}

/** Whether `name` is a folder at the place, where git would read it as a path. */
export function folderAt(place, name) {
  if (place.cwd === null) return false;
  try {
    return Boolean(isFolder(path.join(place.cwd, name)));
  } catch {
    return true;
  }
}
