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
  link: 0x200000, // O_SYMLINK pins the link; O_NOFOLLOW conflicts with this flag.
});

// Actual SDK sys/xattr.h, sys/acl.h, copyfile.h, sys/stdio.h and sys/stat.h.
// ACL objects and external buffers are allocated by libSystem and freed with acl_free.
export function darwinMetadataFunctions(library, checked, koffi) {
  const list = library.func(
    "long flistxattr(int fd, _Out_ void *list, size_t size, int options)",
  );
  const get = library.func(
    "long fgetxattr(int fd, const char *name, _Out_ void *value, size_t size, uint32_t position, int options)",
  );
  const set = library.func(
    "int fsetxattr(int fd, const char *name, const void *value, size_t size, uint32_t position, int options)",
  );
  const remove = library.func("int fremovexattr(int fd, const char *name, int options)");
  const rename = library.func(
    "int renameatx_np(int oldfd, const char *oldname, int newfd, const char *newname, unsigned int flags)",
  );
  const times = library.func("int futimens(int fd, const void *times)");
  const getAcl = library.func("void *acl_get_fd_np(int fd, int type)");
  const setAcl = library.func("int acl_set_fd_np(int fd, void *acl, int type)");
  const internal = library.func("void *acl_copy_int(const void *buffer)");
  const free = library.func("int acl_free(void *acl)");
  const size = library.func("long acl_size(void *acl)");
  const external = library.func(
    "long acl_copy_ext(_Out_ void *buffer, void *acl, long size)",
  );
  const copy = library.func(
    "int fcopyfile(int from_fd, int to_fd, void *state, uint32_t flags)",
  );
  return {
    completeness: { complete: true },
    list: (fd, buffer, size) => checked(list(fd, buffer, size, 0)),
    get: (fd, name, buffer, size) => checked(get(fd, name, buffer, size, 0, 0)),
    set: (fd, name, value) => checked(set(fd, name, value, value.length, 0, 0)),
    remove: (fd, name) => checked(remove(fd, name, 0)),
    rename: (oldfd, oldname, newfd, newname, exchange) =>
      checked(rename(oldfd, oldname, newfd, newname, exchange ? 2 : 4)),
    times: (fd, bytes) => checked(times(fd, bytes)),
    acl(fd) {
      const acl = getAcl(fd, 0x100);
      if (!acl) {
        if (koffi.errno() === 2) return null;
        checked(-1);
      }
      try {
        const length = checked(size(acl));
        if (length > 65536)
          throw Object.assign(new Error("Metadata limit."), {
            code: "FILE_METADATA_LIMIT",
            status: 413,
          });
        const bytes = Buffer.alloc(length);
        checked(external(bytes, acl, length));
        return bytes;
      } finally {
        free(acl);
      }
    },
    // COPYFILE_ACL is metadata-only; COPYFILE_DATA is deliberately absent.
    copyAcl(source, target, expected) {
      checked(copy(source, target, null, 1));
      if (expected == null) return;
      const acl = internal(expected);
      if (!acl) checked(-1);
      try {
        checked(setAcl(target, acl, 0x100));
      } finally {
        free(acl);
      }
    },
  };
}
