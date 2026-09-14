import path from "node:path";
import { createHash } from "node:crypto";
import { resolveFile, entryRevision, isWithin, fileInputPath } from "./file-paths.js";
import { openParent, inodeIdentity, inspect } from "./file-stage.js";
import { scanTree } from "./file-tree.js";
import { alternateName } from "./file-mutations.js";
import { archivePath, archiveOutputLimit } from "./file-archive-paths.js";
import { fileProblem } from "./file-errors.js";

export async function archiveManifest(owner, context) {
  const { scope, operation, signal } = context;
  const selected = [];
  for (const source of new Set(operation.sources)) {
    signal.throwIfAborted();
    selected.push({
      source,
      entry: await resolveFile(scope, fileInputPath(scope, source), {
        followLeaf: false,
      }),
    });
    const pin = context.retry?.pins.find((pin) => pin.source === source);
    const entry = selected.at(-1).entry;
    if (
      pin &&
      (pin.revision !== entryRevision(entry.stat, entry.linkIdentity) ||
        pin.absolute !== entry.absolute)
    )
      throw fileProblem("FILE_RETRY_UNAVAILABLE", 409);
  }
  const unique = new Map();
  for (const item of selected)
    if (!unique.has(item.entry.absolute)) unique.set(item.entry.absolute, item);
  const roots = [...unique.values()].filter((item) => {
    for (
      let parent = path.dirname(item.entry.absolute);
      parent !== path.dirname(parent);
      parent = path.dirname(parent)
    )
      if (unique.get(parent)?.entry.stat.isDirectory()) return false;
    return true;
  });
  const reserved = new Set(
      roots.map(({ entry }) => entry.name || path.basename(entry.absolute) || "root"),
    ),
    used = new Set();
  const rows = [];
  let bytes = 0;
  for (const { source, entry } of roots) {
    let name = entry.name || path.basename(entry.absolute) || "root",
      suffix = 1;
    if (used.has(name))
      do {
        name = alternateName(
          entry.name || path.basename(entry.absolute) || "root",
          ++suffix,
        );
      } while (reserved.has(name) || used.has(name));
    used.add(name);
    const parent = await openParent(owner.publisher.native, entry.absolute);
    try {
      const stat = await inspect(
        owner.publisher.native,
        parent.handle,
        path.basename(entry.absolute),
      );
      if (
        !stat ||
        inodeIdentity(stat) !== inodeIdentity(entry.stat) ||
        entryRevision(stat) !== entryRevision(entry.stat)
      )
        throw fileProblem("FILE_CONFLICT_CHANGED", 409);
      const tree = await scanTree(
        owner.publisher.native,
        parent,
        path.basename(entry.absolute),
        {
          limits: {
            ...owner.limits,
            jobEntries: owner.limits.jobEntries - rows.length,
            jobBytes: owner.limits.jobBytes - bytes,
          },
          signal,
          includeSpecial: true,
        },
      );
      for (const row of tree) {
        const memberName = archivePath(
          name +
            (row.relativePath ? "/" + row.relativePath : "") +
            (row.type === "directory" ? "/" : ""),
          owner.limits,
        );
        const omitted = !["file", "directory"].includes(row.type);
        // The validated member components may be appended, but normalizing the
        // selected prefix would change native global symlink/.. semantics.
        const sourcePath = row.relativePath
          ? `${entry.path}${entry.path && !entry.path.endsWith("/") ? "/" : ""}${row.relativePath}`
          : entry.path;
        rows.push({
          ...row,
          id: String(rows.length),
          source: sourcePath,
          path: sourcePath,
          name: memberName,
          memberName,
          rootSource: source,
          rootAbsolute: entry.absolute,
          rootIdentity: inodeIdentity(entry.stat),
          rootLink: entry.linkIdentity,
          omitted,
          status: omitted ? "skipped" : "pending",
          ...(omitted
            ? {
                issue: {
                  code:
                    row.type === "symlink"
                      ? "FILE_ARCHIVE_LINKS"
                      : "FILE_UNSUPPORTED_TYPE",
                  args: {},
                },
              }
            : {}),
        });
        if (row.type === "file") bytes += row.size;
      }
    } finally {
      await parent.close();
    }
  }
  const manifestVersion = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  for (const row of rows) row.manifestVersion = manifestVersion;
  const written = rows.filter((row) => !row.omitted);
  return {
    rows,
    bytes,
    entries: written.length,
    manifestVersion,
    omissions: rows.some((row) => row.type === "symlink"),
    outputLimit: archiveOutputLimit(
      bytes,
      written.map((row) => row.memberName),
    ),
  };
}
export async function assertArchiveManifest(owner, context, plan) {
  const current = await archiveManifest(owner, context);
  if (current.manifestVersion !== plan.manifestVersion)
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
}
export function rejectArchiveRecursion(rows, target) {
  for (const row of rows)
    if (
      row.type === "directory" &&
      !row.relativePath &&
      isWithin(row.rootAbsolute, target)
    )
      throw fileProblem("FILE_SAME_PATH", 409);
}

export function assertRequiredArchiveSources(before, after) {
  const required = (plan) =>
    plan.rows
      .filter((row) => !row.omitted)
      .map((row) => [
        row.source,
        row.type,
        row.identity,
        row.type === "file" ? row.revision : null,
      ])
      .sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(required(before)) !== JSON.stringify(required(after)))
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
}
