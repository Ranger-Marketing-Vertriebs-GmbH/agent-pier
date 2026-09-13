import { parentPort, workerData } from "node:worker_threads";
import { closeSync, fstatSync, readSync } from "node:fs";
import { getSystemErrorName } from "node:util";
import koffi from "koffi";
import { linuxAbi } from "./file-native-linux.js";
import { darwinAbi } from "./file-native-darwin.js";
import { validateNativeRequest } from "./file-native.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";

const abi = workerData.platform === "darwin" ? darwinAbi : linuxAbi;
const library = koffi.load(abi.library);
const openat = library.func(abi.openat);
const handles = new Map();
let sequence = 0;

function closeAll() {
  for (const { fd } of handles.values()) {
    try {
      closeSync(fd);
    } catch {
      /* Never retry close: the fd may be reused. */
    }
  }
  handles.clear();
}
process.on("exit", closeAll);
process.on("uncaughtExceptionMonitor", closeAll);
parentPort.on("close", closeAll);

function openComponent(parent, component, directory) {
  const flags =
    abi.read |
    abi.nofollow |
    abi.cloexec |
    abi.nonblock |
    (directory ? abi.directory | abi.search : 0);
  const fd = openat(parent, component, flags);
  if (fd < 0) {
    const code = getSystemErrorName(-koffi.errno());
    if (["ELOOP", "ENOTDIR"].includes(code)) throw fileProblem("FILE_PATH_CHANGED", 409);
    throw Object.assign(new Error("Native open failed."), { code });
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (directory ? !stat.isDirectory() : !stat.isFile())
      throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    return { fd, directory, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function keep(opened) {
  const handle = ++sequence;
  handles.set(handle, opened);
  return { handle, dev: opened.dev, ino: opened.ino };
}

function lookup(handle, directory) {
  const opened = handles.get(handle);
  if (!opened || (directory !== undefined && opened.directory !== directory))
    throw fileProblem("FILE_INVALID_PATH", 400);
  return opened;
}

function walk(parent, components, leafDirectory) {
  let owned;
  try {
    for (let index = 0; index < components.length; index++) {
      const opened = openComponent(
        owned?.fd ?? parent,
        components[index],
        index < components.length - 1 || leafDirectory,
      );
      const previous = owned;
      owned = opened;
      if (previous) closeSync(previous.fd);
    }
    const result = keep(owned);
    owned = null;
    return result;
  } finally {
    if (owned) closeSync(owned.fd);
  }
}

function run(operation, args) {
  validateNativeRequest(operation, args);
  if (["openRoot", "openFile"].includes(operation) && handles.size >= 64)
    throw fileProblem("FILE_IO_ERROR", 503);
  switch (operation) {
    case "openRoot": {
      // '/' is the only absolute pathname passed to openat. All ancestor names,
      // including those above the project root, are single no-follow components.
      return walk(abi.cwd, ["/", ...args.path.split("/").filter(Boolean)], true);
    }
    case "openFile":
      return walk(lookup(args.directory, true).fd, args.path.split("/"), false);
    case "read": {
      const { fd } = lookup(args.handle, false);
      const buffer = Buffer.alloc(args.length);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, args.position);
      return buffer.subarray(0, bytesRead);
    }
    case "closeHandle": {
      const { fd } = lookup(args.handle);
      handles.delete(args.handle);
      closeSync(fd);
      return null;
    }
  }
}

parentPort.on("message", ({ id, operation, args }) => {
  try {
    if (operation === "shutdown") {
      closeAll();
      parentPort.postMessage({ id, result: null });
      parentPort.close();
    } else parentPort.postMessage({ id, result: run(operation, args) });
  } catch (cause) {
    const { code, status, args: issueArgs } = fileSystemProblem(cause);
    parentPort.postMessage({ id, error: { code, status, args: issueArgs } });
  }
});
