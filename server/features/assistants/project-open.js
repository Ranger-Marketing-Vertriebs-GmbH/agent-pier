import fs from "node:fs";
import path from "node:path";

/*
 * Opens a resolved path inside a project folder so that no link on the way is
 * followed, not only at the last name: a process that can change the folder could
 * otherwise swap a parent folder for a link between the path check and the open.
 * Node has no openat, so each platform gets one race-free step:
 * - macOS: O_NOFOLLOW_ANY (macOS 11+) makes the kernel refuse a link in any
 *   component of the lookup itself (ELOOP). It replaces O_NOFOLLOW, which the
 *   kernel refuses next to it.
 * - Linux: the open keeps O_NOFOLLOW, and /proc/self/fd/<fd> names the file the
 *   descriptor really refers to. Unless that is the expected path, the open went
 *   through a link and is refused (ELOOP); a file it created exclusively there is
 *   removed, best effort, and the descriptor is always closed.
 * `file` must be a real path (projectTarget's `real`), which holds no link itself.
 * Without /proc the open is refused rather than unchecked.
 */
const { O_NOFOLLOW, O_CREAT, O_EXCL, O_RDONLY, O_DIRECTORY } = fs.constants;
const created = O_CREAT | O_EXCL;
const O_NOFOLLOW_ANY = fs.constants.O_NOFOLLOW_ANY ?? 0x20000000;
const darwin = process.platform === "darwin";

const flagsFor = (flags) =>
  darwin ? (flags & ~O_NOFOLLOW) | O_NOFOLLOW_ANY : flags | O_NOFOLLOW;
const escaped = () =>
  Object.assign(new Error("Path left the folder."), { code: "ELOOP" });

// The path the descriptor refers to, or null when it is not readable.
function openedPath(fd) {
  try {
    return fs.readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    return null;
  }
}

// Whether the descriptor is the file at `file`. Otherwise a file this call created
// exclusively (O_CREAT|O_EXCL, so never one that existed) is removed, best effort.
function verified(fd, file, flags) {
  if (darwin) return true;
  const opened = openedPath(fd);
  if (opened === file) return true;
  if ((flags & created) === created && opened && !opened.endsWith(" (deleted)"))
    try {
      fs.rmSync(opened, { force: true });
    } catch {}
  return false;
}

/** fs.promises.open below a project folder, never through a link. */
export async function openInside(file, flags, mode) {
  const handle = await fs.promises.open(file, flagsFor(flags), mode);
  if (verified(handle.fd, file, flags)) return handle;
  await handle.close();
  throw escaped();
}

/** fs.openSync below a project folder, never through a link. */
export function openInsideSync(file, flags, mode) {
  const fd = fs.openSync(file, flagsFor(flags), mode);
  if (verified(fd, file, flags)) return fd;
  fs.closeSync(fd);
  throw escaped();
}

// The folder's identity (dev/ino), opened again without following any link.
async function folderIdentity(folder) {
  const handle = await openInside(folder, O_RDONLY | O_DIRECTORY);
  try {
    return await handle.stat();
  } finally {
    await handle.close();
  }
}

/**
 * Runs `act(at)` on a folder below a project folder, opened without following any
 * link (openInside). `at(name)` resolves to a path naming `name` (without one: the
 * folder itself) in exactly that opened folder, for lstat, readdir, unlink or rmdir:
 * - Linux: `/proc/self/fd/<fd>/<name>`. The kernel resolves the descriptor's link to
 *   the opened folder itself, so a folder on the way swapped for a link after the
 *   open changes nothing: the call still names the entry in the opened folder.
 * - macOS has no such path and Node no unlinkat: `at` opens the folder again
 *   (O_NOFOLLOW_ANY) and returns the plain path only while it is still the same
 *   folder (dev/ino); after `act` the folder is checked once more. A swap seen by
 *   either check is refused (ELOOP). This narrows the race to the instant between
 *   the last check and the call using the path; it does not close it.
 * `folder` must be a real path, `name` a single entry name.
 */
export async function inFolder(folder, act) {
  const handle = await openInside(folder, O_RDONLY | O_DIRECTORY);
  const entry = (base, name) => {
    if (name.includes("/") || name === "." || name === "..") throw escaped();
    return name ? path.join(base, name) : base;
  };
  try {
    if (!darwin) {
      const base = `/proc/self/fd/${handle.fd}`;
      return await act(async (name = "") => entry(base, name));
    }
    const opened = await handle.stat();
    const check = async () => {
      const now = await folderIdentity(folder);
      if (now.dev !== opened.dev || now.ino !== opened.ino) throw escaped();
    };
    const result = await act(async (name = "") => {
      await check();
      return entry(folder, name);
    });
    await check();
    return result;
  } finally {
    await handle.close();
  }
}
