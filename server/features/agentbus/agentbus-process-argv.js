import { readFileSync } from "node:fs";

let darwinSysctl;
let darwinPidPath;

export async function interpreterExecutable(pid) {
  if (process.platform !== "darwin") return null;
  if (!darwinPidPath) {
    const { default: koffi } = await import("koffi");
    darwinPidPath = koffi
      .load("/usr/lib/libSystem.B.dylib")
      .func("int proc_pidpath(int pid, void *buffer, uint32_t buffersize)");
  }
  const bytes = Buffer.alloc(4096);
  if (darwinPidPath(pid, bytes, bytes.length) <= 0) return null;
  return bytes.toString("utf8", 0, bytes.indexOf(0));
}

/** Read argument boundaries from the OS; never expose argv in errors or logs. */
export async function processArgv(pid) {
  if (process.platform === "linux")
    return readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(0, -1);
  if (process.platform !== "darwin") return [];
  if (!darwinSysctl) {
    const { default: koffi } = await import("koffi");
    darwinSysctl = koffi
      .load("/usr/lib/libSystem.B.dylib")
      .func(
        "int sysctl(const int *name, unsigned int namelen, void *oldp, _Inout_ size_t *oldlenp, const void *newp, size_t newlen)",
      );
  }
  // CTL_KERN / KERN_PROCARGS2: argc, executable, NUL padding, then argc argv strings.
  const bytes = Buffer.alloc(1024 * 1024);
  const size = [bytes.length];
  if (darwinSysctl([1, 49, pid], 3, bytes, size, null, 0) !== 0) return [];
  const argc = bytes.readInt32LE(0);
  if (argc < 1 || argc > 65536) return [];
  let offset = bytes.indexOf(0, 4);
  if (offset < 0 || offset >= size[0]) return [];
  while (offset < size[0] && bytes[offset] === 0) offset++;
  const args = [];
  for (let i = 0; i < argc; i++) {
    const end = bytes.indexOf(0, offset);
    if (end < offset || end >= size[0]) return [];
    args.push(bytes.toString("utf8", offset, end));
    offset = end + 1;
  }
  return args;
}
