import path from "node:path";
import { resolveFile, entryRevision, fileInputPath } from "./file-paths.js";
import { inodeIdentity } from "./file-stage.js";
import { fileProblem } from "./file-errors.js";

const changed = () => fileProblem("FILE_RETRY_UNAVAILABLE", 409);
const guards = new WeakMap();
const snapshot = (entry) => ({
  path: entry.path,
  absolute: entry.absolute,
  linkIdentity: entry.linkIdentity,
  identity: inodeIdentity(entry.stat),
  // Directory timestamps/size change when unrelated siblings are written.
  revision: entry.stat?.isDirectory()
    ? [entry.stat.mode, entry.stat.uid, entry.stat.gid].map(String).join(":")
    : entry.stat
      ? entryRevision(entry.stat, entry.linkIdentity)
      : null,
  directory: Boolean(entry.stat?.isDirectory()),
});

export async function observeRetryDestinations(scope, paths) {
  const result = [];
  for (const input of new Set(paths)) {
    const target = fileInputPath(scope, input);
    let leaf = null,
      parentPath = path.dirname(target),
      parent;
    try {
      leaf = snapshot(
        await resolveFile(scope, target, { followLeaf: false, allowMissingLeaf: true }),
      );
    } catch (error) {
      if (error.code !== "FILE_NOT_FOUND") throw error;
    }
    for (;;) {
      try {
        parent = snapshot(await resolveFile(scope, parentPath));
        if (!parent.directory) throw changed();
        break;
      } catch (error) {
        if (error.code !== "FILE_NOT_FOUND" || parentPath === path.dirname(parentPath))
          throw error;
        parentPath = path.dirname(parentPath);
      }
    }
    result.push({ path: target, leaf, parent });
  }
  return result;
}

export async function assertRetryDestinations(context) {
  if (!context.retry) return;
  const before = context.retry.destinations;
  const after = await observeRetryDestinations(
    context.scope,
    before.map((row) => row.path),
  );
  if (JSON.stringify(before) !== JSON.stringify(after)) throw changed();
}

/** Private stage callback; existing native handles still own publication authority. */
export function retryTargetGuard(context) {
  if (!context.retry) return undefined;
  if (guards.has(context.retry)) return guards.get(context.retry);
  const anchors = new Map();
  for (const proof of context.retry.destinations) {
    anchors.set(proof.parent.path, proof.parent);
    if (proof.leaf?.directory) anchors.set(proof.leaf.path, proof.leaf);
  }
  const guard = async (selected, handle) => {
    if (!context.retry.destinations.length) return;
    const parentPath = fileInputPath(context.scope, path.dirname(selected.path));
    let currentPath = parentPath,
      bound = false;
    for (;;) {
      const anchor = anchors.get(currentPath);
      if (anchor) {
        const current = snapshot(await resolveFile(context.scope, currentPath));
        if (JSON.stringify(current) !== JSON.stringify(anchor)) throw changed();
        bound = true;
      }
      const next = fileInputPath(context.scope, path.dirname(currentPath));
      if (next === currentPath) break;
      currentPath = next;
    }
    // Download artifacts have no public destination; never infer a private path.
    if (!bound) throw changed();
    const parent = await resolveFile(context.scope, parentPath);
    if (
      parent.absolute !== selected.parent ||
      inodeIdentity(parent.stat) !== inodeIdentity(await handle.stat())
    )
      throw changed();
  };
  guards.set(context.retry, guard);
  return guard;
}
