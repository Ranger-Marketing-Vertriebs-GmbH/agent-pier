// Linux UAPI: include/uapi/asm-generic/fcntl.h and
// arch/arm64/include/uapi/asm/fcntl.h (arm64 overrides DIRECTORY/NOFOLLOW).
// https://github.com/torvalds/linux/blob/master/include/uapi/asm-generic/fcntl.h
// openat ABI: https://man7.org/linux/man-pages/man2/open.2.html
export const linuxAbi = Object.freeze({
  library: null, // The process's libc, including glibc and musl.
  openat: "int openat(int dirfd, const char *pathname, int flags, ...)",
  cwd: -100,
  read: 0,
  nonblock: 0x800,
  cloexec: 0x80000,
  search: 0x200000, // O_PATH: lookup permission, no directory read permission.
  directory: process.arch === "arm64" ? 0x4000 : 0x10000,
  nofollow: process.arch === "arm64" ? 0x8000 : 0x20000,
});
