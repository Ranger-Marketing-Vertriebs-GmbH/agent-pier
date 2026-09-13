import { constants, closeSync, fstatSync, fsyncSync, writeSync } from "node:fs";
import { getSystemErrorName } from "node:util";
import koffi from "koffi";
import { fileProblem } from "./file-errors.js";

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
  const openat = library.func(abi.openat);
  const mkdirat = library.func(
    `int mkdirat(int fd, const char *name, ${process.platform === "darwin" ? "uint16_t" : "unsigned int"} mode)`,
  );
  const symlinkat = library.func(
    "int symlinkat(const char *text, int fd, const char *name)",
  );
  const unlinkat = library.func("int unlinkat(int fd, const char *name, int flags)");
  function checked(result) {
    if (result < 0)
      throw Object.assign(Error("Native mutation failed."), {
        code: getSystemErrorName(-koffi.errno()),
      });
    return result;
  }
  function parent(id) {
    const value = lookup(id, true);
    if (value.stream) throw fileProblem("FILE_INVALID_PATH", 400);
    return value.fd;
  }
  function inspect(directory, name) {
    const fd = checked(
      openat(parent(directory), name, abi.link | abi.cloexec | abi.nonblock),
    );
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
      case "inspect":
        return inspect(args.directory, args.name);
      case "createDirectory": {
        const fd = parent(args.directory);
        checked(mkdirat(fd, args.name, 0o700));
        return keep(openComponent(fd, args.name, true));
      }
      case "createFile": {
        const fd = checked(
          openat(
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
          ),
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
        checked(symlinkat(args.text, parent(args.directory), args.name));
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
        const fd = checked(
          openat(opened.fd, ".", abi.read | abi.directory | abi.nofollow | abi.cloexec),
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
        checked(
          unlinkat(
            parent(args.directory),
            args.name,
            args.type === "directory"
              ? process.platform === "darwin"
                ? 0x80
                : 0x200
              : 0,
          ),
        );
        return null;
      }
    }
  };
}
