import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { getSystemErrorName } from "node:util";
import koffi from "koffi";
import { fileProblem } from "./file-errors.js";

const unsupported = () => fileProblem("FILE_EXTRACT_UNSUPPORTED", 409);
function checked(value) {
  if (value >= 0) return value;
  const code = getSystemErrorName(-koffi.errno());
  if (["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "ENOTTY", "EACCES", "EPERM"].includes(code))
    throw unsupported();
  throw Object.assign(new Error("Native name policy query failed."), { code });
}

// Fixed LP64 ABIs only. No pointers, OS fds or mount paths leave the worker.
// Apple sys/mount.h (__DARWIN_STRUCT_STATFS64), sys/attr.h; Linux v6.12
// include/uapi/linux/{stat,fs}.h and asm-generic/statfs.h.
export function namePolicyFunctions(library, abi, lookup) {
  let query;
  return (id) => {
    const parent = lookup(id, true);
    if (parent.stream) throw fileProblem("FILE_INVALID_PATH", 400);
    if (!query) {
      try {
        query = process.platform === "darwin" ? darwin(library) : linux(library, abi);
      } catch {
        throw unsupported(); // Optional symbols never disable unrelated operations.
      }
    }
    const stat = fstatSync(parent.fd, { bigint: true });
    return {
      identity: `${stat.dev}:${stat.ino}`,
      device: String(stat.dev),
      ...query(parent.fd),
    };
  };
}

function darwin(library) {
  const statfs = library.func(
    process.arch === "x64" ? "fstatfs$INODE64" : "fstatfs",
    "int",
    ["int", "void *"],
  );
  const attributes = library.func(
    "int fgetattrlist(int fd, const void *attributes, void *buffer, size_t size, unsigned long options)",
  );
  return (fd) => {
    const fs = Buffer.alloc(4096);
    checked(statfs(fd, fs));
    if (fs.subarray(72, 88).toString().split("\0")[0] !== "apfs") throw unsupported();
    const request = Buffer.alloc(24),
      result = Buffer.alloc(56);
    request.writeUInt16LE(5);
    request.writeUInt32LE(0x80000000, 4); // ATTR_CMN_RETURNED_ATTRS
    request.writeUInt32LE(0x80020000, 8); // ATTR_VOL_INFO | ATTR_VOL_CAPABILITIES
    checked(attributes(fd, request, result, result.length, 0));
    if (
      result.readUInt32LE(0) !== 56 ||
      !(result.readUInt32LE(8) & 0x20000) ||
      (result.readUInt32LE(40) & 0x300) !== 0x300 ||
      !(result.readUInt32LE(24) & 0x200)
    )
      throw unsupported();
    return {
      filesystem: "apfs",
      volume: fs.subarray(48, 56).toString("hex"),
      caseFlags: result.readUInt32LE(24) & 0x300,
    };
  };
}

function mountType(id) {
  let fd;
  try {
    fd = openSync("/proc/self/mountinfo", "r");
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let size = 0,
      n;
    while ((n = readSync(fd, buffer, size, buffer.length - size, null))) {
      size += n;
      if (size === buffer.length) throw unsupported();
    }
    const line = buffer
      .subarray(0, size)
      .toString("utf8")
      .split("\n")
      .find((row) => row.startsWith(id + " "));
    return line?.split(" - ")[1]?.split(" ")[0];
  } catch (error) {
    if (["ENOENT", "EACCES", "EPERM"].includes(error.code)) throw unsupported();
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
function linux(library, abi) {
  const statfs = library.func("int fstatfs(int fd, void *buffer)");
  const statx = library.func(
    "int statx(int fd, const char *path, int flags, unsigned int mask, void *buffer)",
  );
  const ioctl = library.func("int ioctl(int fd, unsigned long request, void *value)");
  const openat = library.func(abi.openat);
  return (fd) => {
    const fs = Buffer.alloc(256),
      extended = Buffer.alloc(256),
      flags = Buffer.alloc(8);
    checked(statfs(fd, fs));
    checked(statx(fd, "", 0x1000, 0x1000, extended));
    const mount = String(extended.readBigUInt64LE(144));
    if (
      !(extended.readUInt32LE(0) & 0x1000) ||
      fs.readBigInt64LE(0) !== 0xef53n ||
      mountType(mount) !== "ext4"
    )
      throw unsupported();
    const opened = checked(
      openat(fd, ".", abi.read | abi.directory | abi.nofollow | abi.cloexec),
    );
    try {
      const before = fstatSync(fd, { bigint: true }),
        actual = fstatSync(opened, { bigint: true });
      if (before.dev !== actual.dev || before.ino !== actual.ino)
        throw fileProblem("FILE_PATH_CHANGED", 409);
      checked(ioctl(opened, 0x80086601, flags)); // FS_IOC_GETFLAGS, LP64 _IOR('f',1,long)
    } finally {
      closeSync(opened);
    }
    if (flags.readUInt32LE(0) & 0x800) throw unsupported();
    return {
      filesystem: "ext4",
      mount,
      volume: fs.subarray(56, 64).toString("hex"),
      caseFlags: flags.readUInt32LE(0) & 0x40000000,
    };
  };
}
