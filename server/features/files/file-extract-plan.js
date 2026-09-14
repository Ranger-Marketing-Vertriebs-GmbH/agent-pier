import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveFile, entryRevision, assertFileMutationTarget } from "./file-paths.js";
import { inodeIdentity } from "./file-stage.js";
import { alternateName } from "./file-mutations.js";
import { fileProblem } from "./file-errors.js";

export const appendExtractPath = (parent, name) =>
  `${parent}${parent.endsWith("/") ? "" : "/"}${name}`;
const typeOf = (stat) =>
  !stat
    ? null
    : stat.isDirectory()
      ? "directory"
      : stat.isFile()
        ? "file"
        : stat.isSymbolicLink()
          ? "symlink"
          : "special";
export async function planExtraction(owner, context, source) {
  const { scope, operation, signal } = context;
  const target = await resolveFile(scope, operation.target);
  if (!target.stat.isDirectory()) throw fileProblem("FILE_NOT_DIRECTORY", 400);
  owner.trash.assertProtected(target.absolute);
  const nodes = new Map(),
    groups = [],
    byGroup = new Map(),
    parents = new Map(),
    aliases = new Map();
  const retryTargets =
    context.retry &&
    new Map(context.retry.targets.map((row) => [row.relative, row.path]));
  const rows = source.rows
    .filter((row) => !retryTargets || retryTargets.has(row.relative))
    .map((row, id) => ({
      ...row,
      id: String(id),
      source: operation.sources[0],
      status: "pending",
      outputPublished: false,
    }));
  if (retryTargets && rows.length !== retryTargets.size)
    throw fileProblem("FILE_RETRY_UNAVAILABLE", 409);
  rows.sort((a, b) => a.relative.split("/").length - b.relative.split("/").length);
  const wildcard = new Map();
  for (const row of rows) {
    signal.throwIfAborted();
    const parentName = path.posix.dirname(row.relative),
      parentNode = nodes.get(parentName);
    const retryPath = retryTargets?.get(row.relative);
    const parent =
      parentNode?.selected ||
      (retryPath ? await resolveFile(scope, path.posix.dirname(retryPath)) : target);
    row.effectiveName = path.posix.basename(retryPath || row.relative);
    row.path = appendExtractPath(parentNode?.path || parent.path, row.effectiveName);
    if (parentNode?.status === "skipped") row.status = "skipped";
    else if (parentNode?.extractGroup) {
      row.extractGroup = parentNode.extractGroup;
      row.groupRelative = parentNode.groupRelative
        ? `${parentNode.groupRelative}/${row.effectiveName}`
        : row.effectiveName;
      byGroup.get(row.extractGroup).rows.push(row);
    } else {
      let selected,
        expectedRevision,
        suffix = 1,
        keepBoth = false;
      for (;;) {
        await owner.freshScope(scope);
        selected = await resolveFile(scope, row.path, {
          followLeaf: false,
          allowMissingLeaf: true,
        });
        assertFileMutationTarget(scope, selected);
        owner.trash.assertProtected(selected.absolute);
        if (selected.absolute === source.selected.absolute)
          throw fileProblem("FILE_SAME_PATH", 409);
        expectedRevision = selected.stat
          ? entryRevision(selected.stat, selected.linkIdentity)
          : null;
        if (!selected.stat) break;
        if (keepBoth) {
          row.effectiveName = alternateName(path.posix.basename(row.relative), ++suffix);
          row.path = appendExtractPath(parent.path, row.effectiveName);
          continue;
        }
        if (selected.stat.isDirectory()) {
          const key = inodeIdentity(selected.stat),
            previous = aliases.get(key);
          if (previous && previous !== row.relative)
            throw fileProblem("FILE_ARCHIVE_ALIAS", 400);
          aliases.set(key, row.relative);
        }
        const targetType = typeOf(selected.stat),
          signature = `${row.type}:${targetType}`;
        const choices =
          row.type === "directory" && targetType === "directory"
            ? ["merge", "skip", "keep_both", "cancel"]
            : row.type === "file" && targetType === "file"
              ? ["replace", "skip", "keep_both", "cancel"]
              : ["skip", "keep_both", "cancel"];
        const revalidate = async () => {
          await owner.freshScope(scope);
          await source.assertUnchanged();
          await owner.publisher.assertExpected(scope, row.path, expectedRevision);
        };
        let decision = wildcard.get(signature);
        if (!decision) {
          decision = await context.conflict({
            type: "name",
            source: row.source,
            target: row.path,
            sourceType: row.type,
            targetType,
            targetRevision: expectedRevision,
            choices,
            revalidate,
          });
          if (decision.applyToRemaining) wildcard.set(signature, decision);
        }
        await revalidate();
        signal.throwIfAborted();
        if (decision.decision === "skip") row.status = "skipped";
        if (decision.decision === "merge") row.merged = true;
        if (decision.decision !== "keep_both") break;
        keepBoth = true;
        row.effectiveName = alternateName(path.posix.basename(row.relative), ++suffix);
        row.path = appendExtractPath(parent.path, row.effectiveName);
      }
      row.selected = selected;
      row.expectedRevision = expectedRevision;
      if (row.status !== "skipped") {
        let known = parents.get(parent.absolute);
        if (!known)
          parents.set(parent.absolute, (known = { selected: parent, rows: [] }));
        row.parentKey = parent.absolute;
        known.rows.push(row);
        if (!row.merged) {
          row.extractGroup = randomUUID();
          row.groupRelative = "";
          const group = { id: row.extractGroup, root: row, rows: [row] };
          groups.push(group);
          byGroup.set(group.id, group);
        } else row.issue = { code: "FILE_MERGE_METADATA_RETAINED", args: {} };
      }
    }
    nodes.set(row.relative, row);
  }
  for (const row of rows)
    await owner.publisher.barrier.run(() => {
      const { selected: _selected, ...stored } = row;
      owner.publisher.store.putEntry(context.jobId, stored);
    });
  await context.report({
    totalBytes: rows.reduce((sum, row) => sum + row.size, 0),
    totalEntries: rows.length,
  });
  return { rows, groups, parents, target };
}

export async function assertExtractParent(owner, scope, parent) {
  const fresh = await resolveFile(await owner.freshScope(scope), parent.selected.path);
  if (
    fresh.absolute !== parent.selected.absolute ||
    fresh.linkIdentity !== parent.selected.linkIdentity ||
    inodeIdentity(fresh.stat) !== inodeIdentity(parent.selected.stat)
  )
    throw fileProblem("FILE_PATH_CHANGED", 409);
}
