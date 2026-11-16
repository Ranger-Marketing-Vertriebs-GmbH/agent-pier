import { lstat, realpath, stat as fsStat } from "node:fs/promises";
import path from "node:path";

// Folders directly below these hold mounted volumes; a missing child there is a
// drive that is not plugged in, not a deleted project.
export const MOUNT_PARENTS = [
  /^\/Volumes$/,
  /^\/media(\/[^/]+)?$/,
  /^\/run\/media\/[^/]+$/,
  /^\/mnt$/,
];

const MISSING = ["ENOENT", "ENOTDIR"];

export function inside(parent, child) {
  return child === parent || child.startsWith(parent + path.sep);
}

async function canonical(target, real) {
  try {
    return await real(target);
  } catch {
    return path.resolve(target);
  }
}

export async function refusedFolder(
  folder,
  {
    home,
    dataDir,
    installDir,
    stat = fsStat,
    lstat: lstatFn = lstat,
    realpath: realFn = realpath,
  },
) {
  const info = await lstatFn(folder);
  if (info.isSymbolicLink()) return "symlink";
  if (!info.isDirectory()) return "not-directory";
  const resolved = await realFn(folder);
  if (resolved !== folder) return "symlink";

  const homeReal = await canonical(home, realFn);
  if (resolved === path.parse(resolved).root) return "root";
  if (resolved === homeReal) return "home";
  if (inside(resolved, homeReal)) return "home-parent";
  if (path.dirname(resolved) === homeReal) return "home-child";
  for (const own of [dataDir, installDir]) {
    const ownReal = await canonical(own, realFn);
    if (inside(ownReal, resolved) || inside(resolved, ownReal)) return "agentpier";
  }
  const [self, parent] = await Promise.all([
    stat(resolved),
    stat(path.dirname(resolved)),
  ]);
  return self.dev !== parent.dev ? "mount-point" : null;
}

export async function folderState(folder, { stat = fsStat, timeoutMs = 2000 } = {}) {
  const bounded = (target) => {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(Object.assign(new Error("stat timed out"), { code: "ETIMEDOUT" })),
        timeoutMs,
      );
    });
    return Promise.race([stat(target), timeout]).finally(() => clearTimeout(timer));
  };
  try {
    return (await bounded(folder)).isDirectory() ? "present" : "missing";
  } catch (e) {
    if (!MISSING.includes(e.code)) return "unavailable";
  }
  let dir = path.dirname(folder);
  for (;;) {
    try {
      await bounded(dir);
      break;
    } catch (e) {
      if (!MISSING.includes(e.code)) return "unavailable";
      if (path.dirname(dir) === dir) break;
      dir = path.dirname(dir);
    }
  }
  return MOUNT_PARENTS.some((re) => re.test(dir)) ? "unavailable" : "missing";
}
