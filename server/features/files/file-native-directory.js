import koffi from "koffi";
import { getSystemErrorName } from "node:util";
import { fileProblem } from "./file-errors.js";

/** Worker-only libc directory streams. No pointer/fd can leave the native owner.
 * fdopendir takes ownership only on success; closedir then owns descriptor close.
 * https://man7.org/linux/man-pages/man3/fdopendir.3.html
 * https://man7.org/linux/man-pages/man3/readdir.3.html
 */
export function directoryFunctions(library, abi) {
  const fdopendir = library.func(abi.fdopendir, "void *", ["int"]);
  const readdir = library.func(abi.readdir, "void *", ["void *"]);
  const closedir = library.func("int closedir(void *directory)");
  const failed = () =>
    Object.assign(new Error("Native directory operation failed."), {
      code: getSystemErrorName(-koffi.errno()),
    });
  return {
    open(fd) {
      const stream = fdopendir(fd);
      if (!stream) throw failed();
      return stream;
    },
    close(stream) {
      if (closedir(stream) < 0) throw failed();
    },
    read(stream) {
      // Only '.' and '..' may be skipped internally: each request stays bounded.
      for (let skipped = 0; skipped < 3; skipped++) {
        koffi.errno(0);
        const pointer = readdir(stream);
        if (!pointer) {
          if (koffi.errno()) throw failed();
          return null;
        }
        const length = koffi.decode(pointer, 16, "uint16_t");
        if (length <= abi.direntName || length > abi.direntName + 1032)
          throw fileProblem("FILE_IO_ERROR", 500);
        const bytes = Buffer.from(
          koffi.decode(
            pointer,
            abi.direntName,
            "uint8_t",
            Math.min(length - abi.direntName, 1024),
          ),
        );
        const end = bytes.indexOf(0);
        if (end < 1) throw fileProblem("FILE_IO_ERROR", 500);
        const name = bytes.subarray(0, end).toString("utf8");
        if (name === "." || name === "..") continue;
        const type = koffi.decode(pointer, abi.direntType, "uint8_t");
        return {
          name,
          type: { 4: "directory", 8: "file", 10: "symlink" }[type] || "unknown",
        };
      }
      throw fileProblem("FILE_IO_ERROR", 500);
    },
  };
}
