import koffi from "koffi";
import { getSystemErrorName } from "node:util";
const darwin = process.platform === "darwin";
const libc = koffi.load(darwin ? "/usr/lib/libSystem.B.dylib" : null);
const set = libc.func(
  darwin
    ? "int fsetxattr(int, const char *, const void *, size_t, uint32_t, int)"
    : "int fsetxattr(int, const char *, const void *, size_t, int)",
);
const list = libc.func(
  darwin
    ? "long flistxattr(int, _Out_ void *, size_t, int)"
    : "long flistxattr(int, _Out_ void *, size_t)",
);
const get = libc.func(
  darwin
    ? "long fgetxattr(int, const char *, _Out_ void *, size_t, uint32_t, int)"
    : "long fgetxattr(int, const char *, _Out_ void *, size_t)",
);
function check(result) {
  if (result < 0) throw new Error(getSystemErrorName(-koffi.errno()));
  return result;
}
export function attachAttributes(fd, name, value) {
  check(
    darwin
      ? set(fd, name, value, value.length, 0, 0)
      : set(fd, name, value, value.length, 0),
  );
}
export function observeAttributes(fd) {
  const names = Buffer.alloc(65536);
  const count = check(
    darwin ? list(fd, names, names.length, 0) : list(fd, names, names.length),
  );
  if (!count) return [];
  return names
    .subarray(0, count - 1)
    .toString()
    .split("\0")
    .sort()
    .map((name) => {
      const bytes = Buffer.alloc(65536);
      const size = check(
        darwin
          ? get(fd, name, bytes, bytes.length, 0, 0)
          : get(fd, name, bytes, bytes.length),
      );
      return { name, value: bytes.subarray(0, size) };
    });
}
