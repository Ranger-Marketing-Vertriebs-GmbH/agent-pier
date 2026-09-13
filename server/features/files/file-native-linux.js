// Linux UAPI: include/uapi/asm-generic/fcntl.h and
// arch/arm64/include/uapi/asm/fcntl.h (arm64 overrides DIRECTORY/NOFOLLOW).
// https://github.com/torvalds/linux/blob/master/include/uapi/asm-generic/fcntl.h
// openat ABI: https://man7.org/linux/man-pages/man2/open.2.html
import { fstatSync, statSync } from "node:fs";
import { fileProblem } from "./file-errors.js";

export const linuxAbi = Object.freeze({
  library: null, // The process's libc, including glibc and musl.
  openat: "int openat(int dirfd, const char *pathname, int flags, ...)",
  // LP64 glibc/musl dirent: ino64, off64, reclen16, type8, name.
  // https://github.com/bminor/glibc/blob/master/sysdeps/unix/sysv/linux/bits/dirent.h
  fdopendir: "fdopendir",
  readdir: "readdir",
  direntName: 19,
  direntType: 18,
  cwd: -100,
  read: 0,
  nonblock: 0x800,
  cloexec: 0x80000,
  search: 0x200000, // O_PATH: lookup permission, no directory read permission.
  directory: process.arch === "arm64" ? 0x4000 : 0x10000,
  link: 0x200000 | (process.arch === "arm64" ? 0x8000 : 0x20000), // O_PATH | O_NOFOLLOW.
  nofollow: process.arch === "arm64" ? 0x8000 : 0x20000,
});

// Linux libc declarations: sys/xattr.h, stdio.h and time.h.
// https://man7.org/linux/man-pages/man2/getxattr.2.html
// https://man7.org/linux/man-pages/man2/setxattr.2.html
// https://man7.org/linux/man-pages/man2/rename.2.html
export function linuxMetadataFunctions(library, checked) {
  const list = library.func("long flistxattr(int fd, _Out_ void *list, size_t size)");
  const get = library.func(
    "long fgetxattr(int fd, const char *name, _Out_ void *value, size_t size)",
  );
  const set = library.func(
    "int fsetxattr(int fd, const char *name, const void *value, size_t size, int flags)",
  );
  const remove = library.func("int fremovexattr(int fd, const char *name)");
  const rename = library.func(
    "int renameat2(int oldfd, const char *oldname, int newfd, const char *newname, unsigned int flags)",
  );
  const flags = library.func("int fcntl(int fd, int command, ...)");
  const mode = library.func("int fchmod(int fd, unsigned int mode)");
  const pathMode = library.func("int chmod(const char *path, unsigned int mode)");
  const isPath = (fd) => (checked(flags(fd, 3)) & 0x200000) !== 0;
  const times = library.func("int futimens(int fd, const void *times)");
  const pathList = library.func(
    "long listxattr(const char *path, _Out_ void *list, size_t size)",
  );
  const pathGet = library.func(
    "long getxattr(const char *path, const char *name, _Out_ void *value, size_t size)",
  );
  const pathSet = library.func(
    "int setxattr(const char *path, const char *name, const void *value, size_t size, int flags)",
  );
  const pathRemove = library.func("int removexattr(const char *path, const char *name)");
  const owner = library.func(
    "int fchownat(int fd, const char *path, unsigned int uid, unsigned int gid, int flags)",
  );
  const linkTimes = library.func(
    "int utimensat(int fd, const char *path, const void *times, int flags)",
  );
  // Like libselinux's O_PATH fallback, this follows only procfs's magic link to
  // the pinned dentry, never the symlink's text or its former mutable filename.
  function bridge(fd) {
    const expected = fstatSync(fd, { bigint: true });
    if (!isPath(fd)) return null;
    const path = `/proc/self/fd/${fd}`;
    let actual;
    try {
      actual = statSync(path, { bigint: true });
    } catch {
      throw fileProblem("FILE_METADATA_UNSUPPORTED", 409);
    }
    if (
      (actual.mode & 0o170000n) !== (expected.mode & 0o170000n) ||
      actual.dev !== expected.dev ||
      actual.ino !== expected.ino
    )
      throw fileProblem("FILE_METADATA_UNSUPPORTED", 409);
    return path;
  }
  return {
    // Linux can hide trusted.* from unprivileged enumeration. Complete visibility
    // has not been proven by this adapter; never certify a new-inode strict copy.
    completeness: { complete: false, reason: "namespace_visibility" },
    mode: (fd, value) => {
      const path = bridge(fd);
      return checked(path ? pathMode(path, value) : mode(fd, value));
    },
    owner: (fd, uid, gid) => checked(owner(fd, "", uid, gid, 0x1100)),
    list: (fd, buffer, size) => {
      const path = bridge(fd);
      return checked(path ? pathList(path, buffer, size) : list(fd, buffer, size));
    },
    get: (fd, name, buffer, size) => {
      const path = bridge(fd);
      return checked(
        path ? pathGet(path, name, buffer, size) : get(fd, name, buffer, size),
      );
    },
    set: (fd, name, value) => {
      const path = bridge(fd);
      return checked(
        path
          ? pathSet(path, name, value, value.length, 0)
          : set(fd, name, value, value.length, 0),
      );
    },
    remove: (fd, name) => {
      const path = bridge(fd);
      return checked(path ? pathRemove(path, name) : remove(fd, name));
    },
    rename: (oldfd, oldname, newfd, newname, exchange) =>
      checked(rename(oldfd, oldname, newfd, newname, exchange ? 2 : 1)),
    times: (fd, bytes) =>
      checked(isPath(fd) ? linkTimes(fd, "", bytes, 0x1100) : times(fd, bytes)),
    acl: () => null,
    copyAcl: () => {},
  };
}
