import { constants, closeSync, fstatSync, fsyncSync, writeSync } from "node:fs";
import { fileProblem } from "./file-errors.js";
import { errnoChecked } from "./file-native-errno.js";

export function nativeStat(fd) {
  const stat = fstatSync(fd, { bigint: true });
  return Object.fromEntries([
    ...["dev", "ino", "mode", "uid", "gid", "size", "mtimeNs", "ctimeNs", "nlink"].map(
      (key) => [key, stat[key]],
    ),
    [
      "type",
      stat.isFile()
        ? "file"
        : stat.isDirectory()
          ? "directory"
          : stat.isSymbolicLink()
            ? "symlink"
            : "special",
    ],
  ]);
}

// POSIX mkdirat/symlinkat/unlinkat declarations; Darwin mode_t is uint16_t,
// Linux mode_t is unsigned int. openat's variadic mode is promoted to int.
export function writeFunctions(library, abi, { lookup, keep, openComponent }) {
  // Each call throws with the errno of its own failure; see file-native-errno.js.
  const func = (declaration) =>
    errnoChecked(library.func(declaration), "Native mutation failed.");
  const openat = func(abi.openat);
  const mkdirat = func(
    `int mkdirat(int fd, const char *name, ${process.platform === "darwin" ? "uint16_t" : "unsigned int"} mode)`,
  );
  const symlinkat = func("int symlinkat(const char *text, int fd, const char *name)");
  // freadlink is optional on macOS11/12; absence must not disable rename/write.
  // Both supported ABIs use a signed64-bit ssize_t (Koffi's long).
  let readlink;
  try {
    readlink =
      process.platform === "darwin"
        ? func("long freadlink(int fd, void *buffer, size_t size)")
        : func("long readlinkat(int fd, const char *name, void *buffer, size_t size)");
  } catch {
    /* Only this capability is unavailable. */
  }
  const unlinkat = func("int unlinkat(int fd, const char *name, int flags)");
  function parent(id) {
    const value = lookup(id, true);
    if (value.stream) throw fileProblem("FILE_INVALID_PATH", 400);
    return value.fd;
  }
  function inspect(directory, name) {
    const fd = openat(parent(directory), name, abi.link | abi.cloexec | abi.nonblock);
    try {
      return nativeStat(fd);
    } finally {
      closeSync(fd);
    }
  }
  return function run(operation, args) {
    switch (operation) {
      case "stat":
        return nativeStat(lookup(args.handle).fd);
      case "readLink": {
        const link = lookup(args.handle, false);
        if (!link.link) throw fileProblem("FILE_INVALID_PATH", 400);
        if (!readlink) throw fileProblem("FILE_NATIVE_UNSUPPORTED", 503);
        const bytes = Buffer.alloc(4097);
        const size =
          process.platform === "darwin"
            ? readlink(link.fd, bytes, bytes.length)
            : readlink(link.fd, "", bytes, bytes.length);
        if (size > 4096) throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
        try {
          return new TextDecoder("utf-8", { fatal: true }).decode(
            bytes.subarray(0, size),
          );
        } catch {
          throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
        }
      }
      case "inspect":
        return inspect(args.directory, args.name);
      case "createDirectory": {
        const fd = parent(args.directory);
        mkdirat(fd, args.name, 0o700);
        return keep(openComponent(fd, args.name, true));
      }
      case "createFile": {
        const fd = openat(
          parent(args.directory),
          args.name,
          constants.O_RDWR |
            constants.O_CREAT |
            constants.O_EXCL |
            abi.nofollow |
            abi.cloexec |
            abi.nonblock,
          "int",
          0o600,
        );
        try {
          const stat = nativeStat(fd);
          if (stat.type !== "file") throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
          return keep({
            fd,
            directory: false,
            writable: true,
            dev: stat.dev,
            ino: stat.ino,
          });
        } catch (error) {
          closeSync(fd);
          throw error;
        }
      }
      case "createLink":
        symlinkat(args.text, parent(args.directory), args.name);
        return inspect(args.directory, args.name);
      case "write": {
        const opened = lookup(args.handle, false);
        if (!opened.writable) throw fileProblem("FILE_INVALID_PATH", 400);
        return writeSync(opened.fd, args.bytes, 0, args.bytes.length, args.position);
      }
      case "sync": {
        const opened = lookup(args.handle);
        if (opened.link) throw fileProblem("FILE_INVALID_PATH", 400);
        if (!opened.directory) {
          fsyncSync(opened.fd);
          return null;
        }
        // Linux lookup roots use O_PATH. Reopen only the pinned directory itself.
        const fd = openat(
          opened.fd,
          ".",
          abi.read | abi.directory | abi.nofollow | abi.cloexec,
        );
        try {
          fsyncSync(fd);
          return null;
        } finally {
          closeSync(fd);
        }
      }
      case "removeEntry": {
        // Prechecked pathname removal, not inode-conditional unlink: an external
        // same-user writer can still replace this name after the observation.
        // Preserve every mismatch we actually observe; never infer ownership
        // from a private-looking name or from directory permissions alone.
        const actual = inspect(args.directory, args.name);
        if (`${actual.dev}:${actual.ino}` !== args.identity || actual.type !== args.type)
          throw fileProblem("FILE_PATH_CHANGED", 409);
        unlinkat(
          parent(args.directory),
          args.name,
          args.type === "directory" ? (process.platform === "darwin" ? 0x80 : 0x200) : 0,
        );
        return null;
      }
    }
  };
}
