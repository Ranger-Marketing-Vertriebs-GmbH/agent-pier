import fs from "node:fs";

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
 *   through a link and is refused (ELOOP); a file it created there is removed.
 * `file` must be a real path (projectTarget's `real`), which holds no link itself.
 * Without /proc the open is refused rather than unchecked.
 */
const { O_NOFOLLOW, O_CREAT } = fs.constants;
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

// Whether the descriptor is the file at `file`; otherwise removes what O_CREAT made.
function verified(fd, file, flags) {
  if (darwin) return true;
  const opened = openedPath(fd);
  if (opened === file) return true;
  if (flags & O_CREAT && opened && !opened.endsWith(" (deleted)"))
    fs.rmSync(opened, { force: true });
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
