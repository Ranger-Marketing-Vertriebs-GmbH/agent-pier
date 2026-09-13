// Apple's public fcntl.h defines the flags and variadic openat signature:
// https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/fcntl.h
export const darwinAbi = Object.freeze({
  library: "/usr/lib/libSystem.B.dylib",
  openat: "int openat(int dirfd, const char *pathname, int flags, ...)",
  // SDK dirent.h/cdefs.h: x64 aliases the 64-bit inode ABI; arm64 is 64-bit only.
  // https://github.com/apple-oss-distributions/Libc/blob/main/include/dirent.h
  // https://github.com/apple-oss-distributions/xnu/blob/main/bsd/sys/dirent.h
  fdopendir: process.arch === "x64" ? "fdopendir$INODE64" : "fdopendir",
  readdir: process.arch === "x64" ? "readdir$INODE64" : "readdir",
  direntName: 21,
  direntType: 20,
  cwd: -2,
  read: 0,
  nonblock: 0x4,
  cloexec: 0x1000000,
  directory: 0x100000,
  search: 0x40000000, // O_SEARCH = O_EXEC | O_DIRECTORY.
  nofollow: 0x100,
});
