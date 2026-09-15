import { parentPort, workerData } from "node:worker_threads";
import { closeSync, fstatSync, readSync } from "node:fs";
import { getSystemErrorName } from "node:util";
import koffi from "koffi";
import { writeFunctions } from "./file-native-write.js";
import { linuxAbi } from "./file-native-linux.js";
import { metadataFunctions } from "./file-native-metadata.js";
import { directoryFunctions } from "./file-native-directory.js";
import { namePolicyFunctions } from "./file-native-names.js";
import { darwinAbi } from "./file-native-darwin.js";
import { validateNativeRequest } from "./file-native.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";

const abi = workerData.platform === "darwin" ? darwinAbi : linuxAbi;
const library = koffi.load(abi.library);
const openat = library.func(abi.openat);
const directories = directoryFunctions(library, abi);
const metadata = metadataFunctions(library, workerData.platform);
const handles = new Map();
let sequence = 0;
const writes = writeFunctions(library, abi, { lookup, keep, openComponent });
const namePolicy = namePolicyFunctions(library, abi, lookup);

function closeOwned(opened) {
  if (opened.stream) directories.close(opened.stream);
  else closeSync(opened.fd);
}
function closeAll() {
  for (const opened of handles.values()) {
    try {
      closeOwned(opened);
    } catch {
      /* Never retry close: the fd may be reused. */
    }
  }
  handles.clear();
}
process.on("exit", closeAll);
process.on("uncaughtExceptionMonitor", closeAll);
parentPort.on("close", closeAll);

function openComponent(parent, component, directory, enumerate = false, link = false) {
  const flags =
    abi.read |
    (link ? abi.link : abi.nofollow) |
    abi.cloexec |
    abi.nonblock |
    (directory ? abi.directory | (enumerate ? 0 : abi.search) : 0);
  const fd = openat(parent, component, flags);
  if (fd < 0) {
    const code = getSystemErrorName(-koffi.errno());
    if (["ELOOP", "ENOTDIR"].includes(code)) throw fileProblem("FILE_PATH_CHANGED", 409);
    throw Object.assign(new Error("Native open failed."), { code });
  }
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (link ? !stat.isSymbolicLink() : directory ? !stat.isDirectory() : !stat.isFile())
      throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    return { fd, directory, link, dev: stat.dev, ino: stat.ino };
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

function walk(parent, components, leafDirectory, enumerate = false, link = false) {
  let owned;
  try {
    for (let index = 0; index < components.length; index++) {
      const opened = openComponent(
        owned?.fd ?? parent,
        components[index],
        index < components.length - 1 || leafDirectory,
        enumerate && index === components.length - 1,
        link && index === components.length - 1,
      );
      const previous = owned;
      owned = opened;
      if (previous) closeSync(previous.fd);
    }
    if (enumerate) owned.stream = directories.open(owned.fd);
    const result = keep(owned);
    owned = null;
    return result;
  } finally {
    if (owned) closeOwned(owned);
  }
}

function rename(...args) {
  try {
    return metadata.rename(...args);
  } catch (error) {
    if (["ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EINVAL"].includes(error.code))
      throw fileProblem("FILE_NATIVE_UNSUPPORTED", 409);
    throw error;
  }
}

function run(operation, args) {
  validateNativeRequest(operation, args);
  if (
    [
      "openRoot",
      "openLookup",
      "openFile",
      "openLink",
      "openDirectory",
      "createFile",
      "createDirectory",
    ].includes(operation) &&
    handles.size >= 64
  )
    throw fileProblem("FILE_IO_ERROR", 503);
  switch (operation) {
    case "namePolicy":
      return namePolicy(args.handle);
    case "createFile":
    case "createDirectory":
    case "createLink":
    case "write":
    case "sync":
    case "stat":
    case "inspect":
    case "readLink":
    case "removeEntry":
      return writes(operation, args);
    case "openRoot": {
      // '/' is the only absolute pathname passed to openat. All ancestor names,
      // including those above the project root, are single no-follow components.
      return walk(abi.cwd, ["/", ...args.path.split("/").filter(Boolean)], true);
    }
    case "openLookup": {
      const parent = lookup(args.directory, true);
      if (parent.stream) throw fileProblem("FILE_INVALID_PATH", 400);
      return walk(parent.fd, args.path ? args.path.split("/") : ["."], true);
    }
    case "openFile":
      return walk(lookup(args.directory, true).fd, args.path.split("/"), false);
    case "openLink": {
      const parent = lookup(args.directory, true);
      if (parent.stream) throw fileProblem("FILE_INVALID_PATH", 400);
      return walk(parent.fd, args.path.split("/"), false, false, true);
    }
    case "openDirectory": {
      const root = lookup(args.directory, true);
      if (root.stream) throw fileProblem("FILE_INVALID_PATH", 400);
      return walk(root.fd, args.path ? args.path.split("/") : ["."], true, true);
    }
    case "readDirectory": {
      const opened = lookup(args.handle, true);
      if (!opened.stream) throw fileProblem("FILE_INVALID_PATH", 400);
      return directories.read(opened.stream);
    }
    case "read": {
      const opened = lookup(args.handle, false);
      if (opened.link) throw fileProblem("FILE_INVALID_PATH", 400);
      const { fd } = opened;
      const buffer = Buffer.alloc(args.length);
      const bytesRead = readSync(fd, buffer, 0, buffer.length, args.position);
      return buffer.subarray(0, bytesRead);
    }
    case "readMetadata":
      return metadata.read(lookup(args.handle).fd);
    case "readBorrowedMetadata":
      return metadata.read(args.handle);
    case "copyMetadata":
      return metadata.copy(
        args.sourceBorrowed ? args.source : lookup(args.source).fd,
        args.targetBorrowed ? args.target : lookup(args.target).fd,
        args,
      );
    case "renameNoReplace":
    case "exchange": {
      const oldParent = lookup(args.oldParent, true),
        newParent = lookup(args.newParent, true);
      if (oldParent.stream || newParent.stream)
        throw fileProblem("FILE_INVALID_PATH", 400);
      rename(
        oldParent.fd,
        args.oldName,
        newParent.fd,
        args.newName,
        operation === "exchange",
      );
      return null;
    }
    case "borrowedRenameNoReplace":
    case "borrowedExchange": {
      if (
        !fstatSync(args.oldParent).isDirectory() ||
        !fstatSync(args.newParent).isDirectory()
      )
        throw fileProblem("FILE_INVALID_PATH", 400);
      rename(
        args.oldParent,
        args.oldName,
        args.newParent,
        args.newName,
        operation === "borrowedExchange",
      );
      return null;
    }
    case "closeHandle": {
      const opened = lookup(args.handle);
      handles.delete(args.handle);
      closeOwned(opened);
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
