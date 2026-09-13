import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  resolveFile,
  entryRevision,
  isWithin,
  assertFileMutationTarget,
} from "./file-paths.js";
import { openTreeSource } from "./file-tree-transfer.js";
import { scanTree } from "./file-tree.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";

export const copyType = (stat) =>
  stat?.isDirectory()
    ? "directory"
    : stat?.isFile()
      ? "file"
      : stat?.isSymbolicLink()
        ? "symlink"
        : "special";
export const revisionOf = (selected) =>
  selected.stat ? entryRevision(selected.stat, selected.linkIdentity) : null;

export function validateCopyOperation(op) {
  return (
    ["copy", "move"].includes(op.kind) &&
    op.sources.length > 0 &&
    typeof op.target === "string" &&
    op.name === null &&
    Object.keys(op.options).length === 0
  );
}

export async function planCopies(owner, context) {
  const { scope, operation, signal } = context;
  const target = await resolveFile(scope, operation.target);
  if (!target.stat.isDirectory()) throw fileProblem("FILE_NOT_DIRECTORY", 400);
  owner.trash.assertProtected(target.absolute);
  const sources = [];
  for (const source of [...new Set(operation.sources)]) {
    signal.throwIfAborted();
    try {
      const selected = await resolveFile(scope, source, { followLeaf: false });
      assertFileMutationTarget(scope, selected);
      owner.trash.assertProtected(selected.absolute);
      if (selected.stat.isDirectory() && isWithin(selected.absolute, target.absolute))
        throw fileProblem("FILE_SAME_PATH", 409);
      sources.push({ source, selected });
    } catch (error) {
      sources.push({ source, error: fileSystemProblem(error) });
    }
  }
  const roots = sources.filter(
    (item, index) =>
      !item.selected ||
      !sources.some(
        (other, i) =>
          i !== index &&
          other.selected &&
          ((other.selected.absolute === item.selected.absolute && i < index) ||
            (other.selected.stat.isDirectory() &&
              other.selected.absolute !== item.selected.absolute &&
              isWithin(other.selected.absolute, item.selected.absolute))),
      ),
  );
  const items = [];
  let entries = 0,
    bytes = 0;
  for (const item of roots) {
    signal.throwIfAborted();
    let rows;
    try {
      if (item.error) throw item.error;
      const opened = await openTreeSource(scope, item.source, owner.publisher.native);
      try {
        rows = await scanTree(owner.publisher.native, opened.parent, opened.name, {
          limits: {
            ...owner.limits,
            jobEntries: owner.limits.jobEntries - entries,
            jobBytes: owner.limits.jobBytes - bytes,
          },
          signal,
          includeSpecial: true,
        });
      } finally {
        await opened.parent.close();
      }
      entries += rows.length;
      bytes += rows.reduce((n, row) => n + (row.type === "file" ? row.size : 0), 0);
      const destination = path.join(target.path, path.basename(item.selected.path));
      for (const row of rows) {
        row.id = randomUUID();
        row.source = path.join(item.selected.path, row.relativePath);
        row.path = path.join(destination, row.relativePath);
        row.status = "pending";
        row.outputPublished = false;
        row.sourceRemoved = false;
        // Bind future wildcard permissions to observations made before any dialog.
        try {
          row.initialTarget = revisionOf(
            await resolveFile(scope, row.path, {
              followLeaf: false,
              allowMissingLeaf: true,
            }),
          );
        } catch {
          row.initialTarget = null;
        }
      }
      items.push({ ...item, rows, target: destination });
    } catch (error) {
      if (entries >= owner.limits.jobEntries)
        throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
      entries++;
      items.push({
        ...item,
        error: fileSystemProblem(error),
        rows: [
          {
            id: randomUUID(),
            source: item.source,
            path: item.source,
            status: "failed",
            issue: fileSystemProblem(error),
          },
        ],
      });
    }
  }
  await owner.publisher.barrier.run(() => {
    for (const item of items)
      for (const row of item.rows) owner.publisher.store.putEntry(context.jobId, row);
  });
  await context.report({ totalEntries: entries, totalBytes: bytes });
  return items;
}
