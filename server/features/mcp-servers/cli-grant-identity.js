import fs from "node:fs";
import path from "node:path";
import {
  insideDirs,
  protectedAncestors,
  protectedDirs,
  sameDir,
} from "../assistants/protected-dirs.js";

const unknown = () => new Error("PROTECTED_ROOT_UNAVAILABLE");

/**
 * The checks of cli-grants.js by device and inode (protected-dirs.js), so another
 * spelling of HOME or the data directory (another case, the macOS firmlink
 * /System/Volumes/Data, a bind mount) gets no broader grant than its usual one.
 * Without `home` and `dataDir` nothing is checked. A protected folder whose identity
 * cannot be determined makes every working directory too broad and every read grant
 * fall into the data directory: fail closed.
 */
export function grantIdentity({ home = null, dataDir = null } = {}) {
  const roots = [home, dataDir].filter(Boolean);
  if (!roots.length) return { tooBroad: () => false, inData: () => false };
  let guarded, ancestors, data;
  try {
    guarded = protectedDirs(roots, unknown);
    ancestors = protectedAncestors(roots, unknown);
    data = dataDir ? protectedDirs([dataDir], unknown) : [];
  } catch {
    return { tooBroad: () => true, inData: () => true };
  }
  const devices = new Set(guarded.map((dir) => dir.dev));
  return {
    // `/`, HOME, the data directory or a folder above either, a folder in the data
    // directory, or a mount's root on the device that holds either.
    // A folder that does not exist yet is only checked for lying in the data
    // directory; one that cannot be looked at is too broad.
    tooBroad(dir) {
      if (insideDirs(dir, data)) return true;
      let stat, parent;
      try {
        stat = fs.statSync(dir, { bigint: true });
        parent = fs.statSync(path.dirname(dir), { bigint: true });
      } catch (error) {
        return error.code !== "ENOENT";
      }
      return (
        sameDir(guarded, stat) ||
        sameDir(ancestors, stat) ||
        (stat.dev !== parent.dev && devices.has(stat.dev))
      );
    },
    inData: (file) => insideDirs(path.dirname(file), data),
  };
}
