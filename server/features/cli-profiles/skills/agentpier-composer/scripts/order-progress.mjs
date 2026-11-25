// Shipped standalone. The server imports the same read/modify/write and locking
// primitives as the native skill, so an owner edit and a checkpoint can overlap.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const limit = 2 * 1024 * 1024;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK } = fs.constants;
export const orderFilename = (name) =>
  typeof name === "string" &&
  name.endsWith(".json") &&
  !name.startsWith(".") &&
  !/[\x00-\x1f/\\]/.test(name) &&
  Buffer.byteLength(name) <= 255;
const object = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function unsafe() {
  throw Object.assign(new Error("Unsafe or invalid Composer order file."), {
    code: "ORDER_UNSAFE",
  });
}
export function orderDirectory(common, create = false) {
  if (!path.isAbsolute(common) || fs.realpathSync(common) !== common) unsafe();
  const folder = path.join(common, "agentpier-composer");
  if (create) {
    try {
      fs.mkdirSync(folder, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const stat = fs.lstatSync(folder);
  if (!stat.isDirectory() || stat.uid !== process.getuid()) unsafe();
  return folder;
}

function readDocument(folder, name) {
  if (!orderFilename(name)) unsafe();
  const fd = fs.openSync(path.join(folder, name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > limit ||
      stat.uid !== process.getuid()
    )
      unsafe();
    const value = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!object(value)) unsafe();
    return value;
  } finally {
    fs.closeSync(fd);
  }
}

// The same private per-user location in GUI launches and CLI-specific TMPDIRs.
function writesDirectory() {
  const uid = process.getuid();
  const dir = path.join(fs.realpathSync("/tmp"), `agentpier-composer-writes-${uid}`);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || stat.mode & 0o077) unsafe();
  return dir;
}

// Only a lock, containing no data. BEGIN IMMEDIATE obtains an OS-managed
// exclusive writer reservation on both platforms; process exit releases it.
export function withOrderLock(work) {
  const db = new DatabaseSync(path.join(writesDirectory(), "writer.sqlite"));
  try {
    db.exec("PRAGMA busy_timeout=3000; BEGIN IMMEDIATE");
    return work();
  } finally {
    db.close();
  }
}

function writeDocument(folder, name, document, { exclusive = false } = {}) {
  if (!orderFilename(name) || !object(document)) unsafe();
  const content = JSON.stringify(document, null, 2) + "\n";
  if (Buffer.byteLength(content) > limit) unsafe();
  const dest = path.join(folder, name);
  const tmp = path.join(folder, `.order-${randomUUID()}.tmp`);
  fs.writeFileSync(tmp, content, { flag: "wx", mode: 0o600, flush: true });
  try {
    if (exclusive) fs.linkSync(tmp, dest);
    else fs.renameSync(tmp, dest);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}
// Pin the Composer directory for every operation. Renaming it cannot redirect
// a subsequent lookup or unlink through a replacement symlink. Linux exposes a
// directory fd in procfs. On macOS a child can do the same work relative to its
// cwd after checking that cwd against the inherited, still-open directory fd.
function perform(folder, operation, args) {
  if (operation === "read") return readDocument(folder, ...args);
  if (operation === "write") return writeDocument(folder, ...args);
  if (operation === "remove") {
    const [name, id] = args;
    if (readDocument(folder, name).id !== id) unsafe();
    fs.unlinkSync(path.join(folder, name));
    return;
  }
  unsafe();
}
// The child reads its request from a file that is already unlinked, never from a
// pipe: on macOS a synchronous spawn now and then never finishes writing an `input`
// above 64 KiB, the child then waits for the end of its stdin and the caller for the
// child. An order with a long brief did that to the server, which holds the order
// lock meanwhile. The time limit bounds whatever else may keep the child.
function requestFile(request) {
  const file = path.join(writesDirectory(), `.request-${randomUUID()}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(request), { flag: "wx", mode: 0o600 });
    return fs.openSync(file, O_RDONLY | O_NOFOLLOW);
  } finally {
    fs.rmSync(file, { force: true });
  }
}
function pinned(folder, operation, args) {
  if (fs.realpathSync(folder) !== folder) unsafe();
  const fd = fs.openSync(folder, O_RDONLY | O_NOFOLLOW | fs.constants.O_DIRECTORY);
  let request;
  try {
    if (fs.fstatSync(fd).uid !== process.getuid()) unsafe();
    if (process.platform === "linux")
      return perform(`/proc/self/fd/${fd}`, operation, args);
    request = requestFile({ operation, args });
    const output = execFileSync(
      process.execPath,
      [fileURLToPath(import.meta.url), "--pinned"],
      {
        cwd: folder,
        encoding: "utf8",
        stdio: [request, "pipe", "pipe", fd],
        maxBuffer: limit * 2,
        timeout: 30000,
        killSignal: "SIGKILL",
      },
    );
    const result = JSON.parse(output);
    if (result.error)
      throw Object.assign(new Error("Cannot access Composer order."), {
        code: result.error,
      });
    return result.value;
  } finally {
    fs.closeSync(fd);
    if (request !== undefined) fs.closeSync(request);
  }
}

export const readOrderFile = (folder, name) => pinned(folder, "read", [name]);
export const writeOrderFile = (folder, name, document, options = {}) =>
  pinned(folder, "write", [name, document, options]);
export const removeOrderFile = (folder, name, id) => pinned(folder, "remove", [name, id]);

const progress = new Set([
  "status",
  "planStatus",
  "draftBatches",
  "batches",
  "checkpoint",
  "nextAction",
  "findings",
  "tickets",
  "runs",
  "pullRequests",
  "lastCheckedAt",
  "nextCheckAt",
  "schedulerId",
]);
function itemIds(items) {
  if (!Array.isArray(items)) throw new Error("Batches and items must be arrays.");
  const ids = new Set();
  for (const item of items) {
    if (
      !object(item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      ids.has(item.id)
    )
      throw new Error("Give each batch and each item a stable, unique string ID.");
    ids.add(item.id);
    if (item.items !== undefined) itemIds(item.items);
  }
}
export function patchProgress(common, name, patch) {
  if (!object(patch) || Object.keys(patch).some((key) => !progress.has(key)))
    throw new Error("Unknown or owner-controlled Composer order field.");
  for (const key of ["draftBatches", "batches"]) if (key in patch) itemIds(patch[key]);
  return withOrderLock(() => {
    const folder = orderDirectory(common);
    const doc = readOrderFile(folder, name);
    if (doc.schemaVersion === 1 && name !== doc.id + ".json") unsafe();
    if (
      doc.manualPaused === true &&
      Object.keys(patch).some((key) => !["checkpoint", "nextAction"].includes(key))
    )
      throw new Error(
        "The owner paused this order. Save the checkpoint and await resume.",
      );
    writeOrderFile(folder, name, { ...doc, ...patch });
  });
}

if (import.meta.main) {
  try {
    if (process.argv[2] === "--pinned") {
      const held = fs.fstatSync(3, { bigint: true });
      const cwd = fs.statSync(".", { bigint: true });
      if (held.dev !== cwd.dev || held.ino !== cwd.ino) unsafe();
      const { operation, args } = JSON.parse(fs.readFileSync(0, "utf8"));
      let response;
      try {
        response = { value: perform(".", operation, args) };
      } catch (error) {
        response = { error: error.code || "ORDER_UNSAFE" };
      }
      process.stdout.write(JSON.stringify(response));
    } else {
      const common = fs.realpathSync(
        execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
          encoding: "utf8",
        }).trimEnd(),
      );
      patchProgress(common, process.argv[2], JSON.parse(fs.readFileSync(0, "utf8")));
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
