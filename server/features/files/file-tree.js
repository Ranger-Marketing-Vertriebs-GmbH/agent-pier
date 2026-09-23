import path from "node:path";
import { createHash } from "node:crypto";
import { fileProblem } from "./file-errors.js";
import { entryRevision } from "./file-paths.js";
import { ownedHandle, inspect, inodeIdentity, contentIdentity } from "./file-stage.js";
import { readFileLimits } from "./file-limits.js";

export const treeConflict = () => fileProblem("FILE_CONFLICT_CHANGED", 409);
export const treeRevision = (rows) =>
  `t1:${createHash("sha256")
    .update(
      JSON.stringify(
        rows
          .map(({ relativePath, revision }) => [relativePath, revision])
          .sort(([a], [b]) => a.localeCompare(b)),
      ),
    )
    .digest("hex")}`;
export const treeRow = (relativePath, stat) => ({
  relativePath,
  identity: inodeIdentity(stat),
  revision: entryRevision(stat),
  content: contentIdentity(stat),
  type: stat.type,
  size: Number(stat.size),
});

// Constant live-handle budget: reopen each recorded ancestor relative to a pinned
// root parent, checking every component. No directory stream is a lookup parent.
export async function treeParent(native, rootParent, rootName, relativePath, rows) {
  let parent = ownedHandle(
    native,
    await native.run("openLookup", { directory: rootParent.handle, path: "" }),
  );
  try {
    const pieces = relativePath
      ? [rootName, ...relativePath.split("/").slice(0, -1)]
      : [];
    let relative = "";
    for (let index = 0; index < pieces.length; index++) {
      const next = ownedHandle(
        native,
        await native.run("openLookup", { directory: parent.handle, path: pieces[index] }),
      );
      const expected =
        rows instanceof Map
          ? rows.get(relative)
          : rows.find((row) => row.relativePath === relative);
      try {
        if (!expected || inodeIdentity(await next.stat()) !== expected.identity)
          throw treeConflict();
      } catch (error) {
        await next.close();
        throw error;
      }
      await parent.close();
      parent = next;
      if (index + 1 < pieces.length)
        relative = relative ? `${relative}/${pieces[index + 1]}` : pieces[index + 1];
    }
    return parent;
  } catch (error) {
    await parent.close();
    throw error;
  }
}
export const treeName = (rootName, relativePath) =>
  relativePath ? path.basename(relativePath) : rootName;
export async function scanTree(
  native,
  parent,
  name,
  {
    limits = readFileLimits(),
    signal,
    report = async () => {},
    includeSpecial = false,
  } = {},
) {
  const rows = [],
    queue = [""];
  const indexed = new Map();
  let bytes = 0;
  for (let index = 0; index < queue.length; index++) {
    signal?.throwIfAborted();
    const relativePath = queue[index];
    if (
      index >= limits.jobEntries ||
      relativePath.split("/").filter(Boolean).length > limits.maxDepth
    )
      throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
    const current = await treeParent(native, parent, name, relativePath, indexed);
    let stream;
    try {
      const stat = await inspect(native, current.handle, treeName(name, relativePath));
      if (!stat) throw treeConflict();
      if (!includeSpecial && !["file", "directory", "symlink"].includes(stat.type))
        throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
      bytes += stat.type === "file" ? Number(stat.size) : 0;
      if (!Number.isSafeInteger(bytes) || bytes > limits.jobBytes)
        throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
      const row = treeRow(relativePath, stat);
      rows.push(row);
      indexed.set(relativePath, row);
      await report({ entry: row });
      if (stat.type === "directory") {
        stream = ownedHandle(
          native,
          await native.run("openDirectory", {
            directory: current.handle,
            path: treeName(name, relativePath),
          }),
        );
        if (inodeIdentity(await stream.stat()) !== row.identity) throw treeConflict();
        let child;
        const names = [];
        while ((child = await native.run("readDirectory", { handle: stream.handle }))) {
          signal?.throwIfAborted();
          if (queue.length + names.length >= limits.jobEntries)
            throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
          names.push(child.name);
        }
        if (entryRevision(await stream.stat()) !== row.revision) throw treeConflict();
        // readdir order is filesystem-specific (hashed and per-volume seeded on
        // ext4), so process siblings in a stable order on every platform.
        names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
        for (const childName of names)
          queue.push(relativePath ? `${relativePath}/${childName}` : childName);
      }
    } finally {
      await stream?.close();
      await current.close();
    }
  }
  return rows;
}
export async function assertTree(native, parent, name, rows, options = {}) {
  const actual = await scanTree(native, parent, name, options);
  const sorted = (values) =>
    values
      .map((row) => [row.relativePath, row.revision])
      .sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(sorted(actual)) !== JSON.stringify(sorted(rows)))
    throw treeConflict();
  return actual;
}
export async function removeTree(
  native,
  parent,
  name,
  rows,
  { report = async () => {}, mutate = (fn) => fn(), ...options } = {},
) {
  await assertTree(native, parent, name, rows, options);
  for (const row of [...rows].reverse()) {
    options.signal?.throwIfAborted();
    if (
      options.includeSpecial &&
      (row.type === "special" ||
        (row.type === "directory" &&
          rows.some(
            (child) =>
              child.type === "special" &&
              (!row.relativePath ||
                child.relativePath.startsWith(row.relativePath + "/")),
          )))
    )
      continue;
    const current = await treeParent(native, parent, name, row.relativePath, rows);
    try {
      await mutate(async () => {
        const stat = await inspect(
          native,
          current.handle,
          treeName(name, row.relativePath),
        );
        if (
          !stat ||
          inodeIdentity(stat) !== row.identity ||
          (row.type !== "directory" && entryRevision(stat) !== row.revision)
        )
          throw treeConflict();
        // Finite prechecked pathname removal; preserve all observed mismatches.
        await native.run("removeEntry", {
          directory: current.handle,
          name: treeName(name, row.relativePath),
          identity: row.identity,
          type: row.type,
        });
        await current.sync();
        await report({ entry: { ...row, removed: true } });
      });
    } finally {
      await current.close();
    }
  }
}
