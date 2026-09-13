// Apple's public fcntl.h defines the flags and variadic openat signature:
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
export const darwinAbi = Object.freeze({
  library: "/usr/lib/libSystem.B.dylib",
  openat: "int openat(int dirfd, const char *pathname, int flags, ...)",
  cwd: -2,
  read: 0,
  nonblock: 0x4,
  cloexec: 0x1000000,
  directory: 0x100000,
  search: 0x40000000, // O_SEARCH = O_EXEC | O_DIRECTORY.
  nofollow: 0x100,
});
