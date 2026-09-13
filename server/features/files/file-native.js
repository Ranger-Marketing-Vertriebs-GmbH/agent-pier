import { Worker } from "node:worker_threads";
import { fileProblem } from "./file-errors.js";

const operations = {
  openRoot: ["path"],
  openFile: ["directory", "path"],
  read: ["handle", "length", "position"],
  closeHandle: ["handle"],
};
export const nativeReadBytes = 64 * 1024;

// Validate before structured cloning, and again at the worker boundary.
export function validateNativeRequest(operation, args) {
  const keys = Object.hasOwn(operations, operation) && operations[operation];
  const invalid = () => {
    throw fileProblem("FILE_INVALID_PATH", 400);
  };
  if (!keys || !args || typeof args !== "object" || Array.isArray(args)) invalid();
  if (Object.keys(args).length !== keys.length) invalid();
  for (const key of keys) {
    const value = args[key];
    if (key === "path") {
      if (
        typeof value !== "string" ||
        !value ||
        value.includes("\0") ||
        Buffer.byteLength(value) > 4096
      )
        invalid();
      const absolute = operation === "openRoot";
      if (value.startsWith("/") !== absolute) invalid();
      const components = (absolute ? value.slice(1) : value).split("/");
      if (
        value !== "/" &&
        components.some(
          (part) =>
            !part || part === "." || part === ".." || Buffer.byteLength(part) > 255,
        )
      )
        invalid();
    } else if (!Number.isSafeInteger(value) || value < (key === "position" ? 0 : 1))
      invalid();
  }
  if (
    operation === "read" &&
    (args.length > nativeReadBytes ||
      args.position > Number.MAX_SAFE_INTEGER - args.length)
  )
    invalid();
}

/** A read-only POSIX worker. Handles are opaque, local to this instance, and must
 * be closed via closeHandle or close(). No raw fd crosses the worker boundary.
 */
export class FileNative {
  #worker;
  #pending = new Map();
  #sequence = 0;
  #closing = null;
  #failed = false;
  #exited;

  constructor({ platform = process.platform } = {}) {
    if (
      platform !== process.platform ||
      !["darwin", "linux"].includes(platform) ||
      !["x64", "arm64"].includes(process.arch)
    )
      throw fileProblem("FILE_IO_ERROR", 500);
    this.#worker = new Worker(new URL("./file-native-worker.js", import.meta.url), {
      workerData: { platform },
      // Native opens are owned here, not registered in Node's fd tracker.
      trackUnmanagedFds: false,
      // This fixed module needs no parent CLI options. Explicitly copying them
      // rejects process/V8 flags, and inheriting eval --input-type breaks files.
      execArgv: [],
    });
    this.#worker.on("message", ({ id, result, error }) => {
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      if (error) pending.reject(fileProblem(error.code, error.status, error.args));
      else pending.resolve(result);
    });
    const fail = () => {
      this.#failed = true;
      for (const pending of this.#pending.values())
        pending.reject(fileProblem("FILE_IO_ERROR", 500));
      this.#pending.clear();
    };
    this.#worker.on("error", fail);
    this.#exited = new Promise((resolve) =>
      this.#worker.once("exit", () => {
        fail();
        resolve();
      }),
    );
  }

  async run(operation, args) {
    if (this.#closing || this.#failed) throw fileProblem("FILE_IO_ERROR", 500);
    validateNativeRequest(operation, args);
    if (this.#pending.size >= 64) throw fileProblem("FILE_IO_ERROR", 503);
    return this.#send(operation, args);
  }

  #send(operation, args) {
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.#worker.postMessage({ id, operation, args });
      } catch {
        this.#pending.delete(id);
        reject(fileProblem("FILE_IO_ERROR", 500));
      }
    });
  }

  close() {
    this.#closing ||= (async () => {
      if (!this.#failed) await this.#send("shutdown", {}).catch(() => {});
      await this.#exited;
    })();
    return this.#closing;
  }
}
