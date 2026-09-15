import { FileNative } from "./file-native.js";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveFile } from "./file-paths.js";
import { projectFileEntry } from "./file-reading.js";
import { fileProblem } from "./file-errors.js";

export function validateMetadataOperation(operation) {
  const { kind, sources, target, name, options } = operation;
  if (sources.length !== 1 || target !== null || name !== null) return false;
  if (kind === "size") return Object.keys(options).length === 0;
  return (
    kind === "search" &&
    Object.keys(options).length === 4 &&
    typeof options.query === "string" &&
    options.query.length > 0 &&
    options.query.length <= 256 &&
    !options.query.includes("\0") &&
    ["recursive", "hidden", "caseSensitive"].every(
      (key) => typeof options[key] === "boolean",
    )
  );
}

export function searchFiles(args) {
  return walk(args, false);
}
export function measureFiles(args) {
  return walk(args, true);
}

/** Metadata only. The bounded depth stack contains paths, never retained enumerators.
 * The injected store facade awaits a short barrier lease for each durable result.
 */
async function walk(
  { scope, operation, signal, report, store, jobId, limits, now = Date.now },
  measuring,
) {
  const deadline = now() + limits.searchMs;
  // Every queued record comes from a scanned directory: at most searchEntries records.
  // Keep only path/depth/identity, and never a retained ancestor enumerator.
  const stack = [];
  const frameFor = (resolved, depth) => ({
    path: resolved.path,
    depth,
    stat: { dev: resolved.stat.dev, ino: resolved.stat.ino },
  });
  let native, anchor, current;
  let visited = 0,
    results = 0,
    bytes = 0,
    reason = null;
  const omit = (value) => {
    reason ??= value;
  };
  const progress = (complete = false) =>
    report({
      completedEntries: visited,
      completedBytes: bytes,
      totalEntries: complete && !reason ? visited : null,
      totalBytes: measuring && complete && !reason ? bytes : null,
      issue: reason
        ? {
            code: measuring ? "FILE_SIZE_INCOMPLETE" : "FILE_SEARCH_INCOMPLETE",
            args: { reason },
          }
        : null,
    });
  const interrupted = () => {
    signal.throwIfAborted();
    if (now() >= deadline) {
      omit("time");
      return true;
    }
    return false;
  };
  const omittedError = (error) =>
    omit(
      ["EACCES", "EPERM", "FILE_ACCESS_DENIED"].includes(error.code)
        ? "access"
        : [
              "FILE_OUTSIDE_SCOPE",
              "FILE_PATH_CHANGED",
              "FILE_NOT_FOUND",
              "ENOENT",
              "ENOTDIR",
            ].includes(error.code)
          ? "changed"
          : "io",
    );
  const sameIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;
  const openDirectory = async (frame) => {
    const fresh = await resolveFile(scope, frame.path, { followLeaf: false });
    if (
      fresh.linkIdentity ||
      !fresh.stat.isDirectory() ||
      !sameIdentity(fresh.stat, frame.stat)
    )
      throw fileProblem("FILE_PATH_CHANGED", 409);
    if (interrupted()) return null;
    if (!native) {
      const root = await resolveFile(scope, scope.kind === "project" ? "" : "/", {
        followLeaf: false,
      });
      if (interrupted()) return null;
      native = new FileNative();
      anchor = {
        ...(await native.run("openRoot", { path: root.absolute })),
        path: root.absolute,
      };
      if (!sameIdentity(anchor, root.stat)) throw fileProblem("FILE_PATH_CHANGED", 409);
    }
    if (interrupted()) return null;
    // Native openat traverses every component relative to the pinned root with NOFOLLOW.
    const directory = await native.run("openDirectory", {
      directory: anchor.handle,
      path: path.relative(anchor.path, fresh.absolute),
    });
    if (!sameIdentity(directory, fresh.stat)) {
      await native.run("closeHandle", { handle: directory.handle });
      throw fileProblem("FILE_PATH_CHANGED", 409);
    }
    return { ...frame, handle: directory.handle };
  };
  const addSize = (stat) => {
    if (stat.size > BigInt(Number.MAX_SAFE_INTEGER - bytes)) {
      omit("overflow");
      return false;
    }
    bytes += Number(stat.size);
    return true;
  };
  try {
    signal.throwIfAborted();
    const root = await resolveFile(scope, operation.sources[0], { followLeaf: false });
    if (interrupted()) {
      await progress(true);
      return;
    }
    if (root.linkIdentity || root.stat.isSymbolicLink()) omit("changed");
    else if (measuring && root.stat.isFile()) {
      visited = 1;
      addSize(root.stat);
    } else if (root.stat.isDirectory()) stack.push(frameFor(root, 0));
    else throw fileProblem("FILE_NOT_DIRECTORY", 400);
    const options = operation.options;
    const query = measuring
      ? ""
      : options.caseSensitive
        ? options.query
        : options.query.toLowerCase();
    while ((current || stack.length) && !interrupted()) {
      if (!current) {
        try {
          current = await openDirectory(stack.pop());
        } catch (error) {
          signal.throwIfAborted();
          omittedError(error);
        }
        if (!current) continue;
      }
      if (interrupted()) break;
      const frame = current;
      let entry;
      try {
        entry = await native.run("readDirectory", { handle: frame.handle });
      } catch (error) {
        omittedError(error);
        await native.run("closeHandle", { handle: frame.handle });
        current = null;
        continue;
      }
      if (!entry) {
        await native.run("closeHandle", { handle: frame.handle });
        current = null;
        continue;
      }
      if (visited >= limits.searchEntries) {
        omit("entries");
        break;
      }
      visited++;
      if (interrupted()) break;
      if (
        entry.type === "symlink" ||
        (!measuring && !options.hidden && entry.name.startsWith("."))
      )
        continue;
      const selected =
        scope.kind === "project"
          ? [frame.path, entry.name].filter(Boolean).join("/")
          : path.join(frame.path, entry.name);
      try {
        const resolved = await resolveFile(scope, selected, { followLeaf: false });
        if (resolved.linkIdentity || resolved.stat.isSymbolicLink()) {
          omit("changed");
          continue;
        }
        if (interrupted()) break;
        if (measuring && resolved.stat.isFile()) {
          if (!addSize(resolved.stat)) break;
        } else if (
          !measuring &&
          (options.caseSensitive ? entry.name : entry.name.toLowerCase()).includes(query)
        ) {
          if (results >= limits.searchResults) {
            omit("results");
            break;
          }
          const metadata = await projectFileEntry(scope, resolved);
          if (interrupted()) break;
          await store.putEntry(jobId, { id: randomUUID(), ...metadata });
          results++;
        }
        if (resolved.stat.isDirectory() && (measuring || options.recursive)) {
          if (frame.depth >= limits.maxDepth) omit("depth");
          else stack.push(frameFor(resolved, frame.depth + 1));
        }
      } catch (error) {
        signal.throwIfAborted();
        omittedError(error);
      }
      // Await persistence: a slow reporter cannot leave an unbounded promise backlog.
      await progress();
    }
    interrupted();
    await progress(true);
  } finally {
    if (native) await native.close();
  }
}
