import path from "node:path";
import { alternateName } from "./file-mutations.js";
import { resolveFile, entryRevision } from "./file-paths.js";
import { fileProblem } from "./file-errors.js";
import { assertTree, treeRevision } from "./file-tree.js";
import { inspect } from "./file-stage.js";

export function restoreAuthority(trash, scope, record, revision) {
  let scanned = false;
  return async (source) => {
    await trash.freshScope(scope);
    trash.authorized(scope, record.id);
    if (!scanned) {
      const rows = await assertTree(
        trash.native,
        source.parent,
        source.name,
        record.payloadManifest,
        { limits: trash.limits },
      );
      if (treeRevision(rows) !== revision)
        throw fileProblem("FILE_CONFLICT_CHANGED", 409);
      scanned = true;
    } else {
      // The complete tree was checked outside the mutation lease. At adoption,
      // recheck the selected root and scope immediately before the native rename.
      const root = await inspect(trash.native, source.parent.handle, source.name);
      if (!root || entryRevision(root) !== record.payloadManifest[0].revision)
        throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    }
  };
}

export const restoreType = (stat) =>
  stat?.isDirectory()
    ? "directory"
    : stat?.isSymbolicLink()
      ? "symlink"
      : stat?.isFile()
        ? "file"
        : "special";

export function assertRestoreType(record, selected) {
  if (
    selected.stat &&
    (record.type === "directory" || record.type !== restoreType(selected.stat))
  )
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
}

export async function restoreSelection(trash, context) {
  const { scope, operation, conflict, signal, jobId } = context;
  const id = operation.sources[0];
  const record = trash.authorized(scope, id);
  const observed = await trash.observe(record);
  const pin = context.retry?.pins.find((pin) => pin.trashId === id);
  if (pin && pin.revision !== observed.revision)
    throw fileProblem("FILE_RETRY_UNAVAILABLE", 409);
  if (observed.availability !== "recoverable")
    throw fileProblem("FILE_CONFLICT_CHANGED", 409);
  const current = await resolveFile(scope, operation.target, {
    followLeaf: false,
    allowMissingLeaf: true,
  });
  let target = operation.target;
  let expectedRevision = operation.options.expectedRevision;
  if (expectedRevision === undefined) {
    expectedRevision = current.stat
      ? entryRevision(current.stat, current.linkIdentity)
      : null;
    if (expectedRevision) {
      const sourceType = record.type,
        targetType = restoreType(current.stat);
      const choices =
        sourceType !== "directory" && sourceType === targetType
          ? ["replace", "skip", "keep_both", "cancel"]
          : ["keep_both", "skip", "cancel"];
      const selectedRevision = expectedRevision;
      const decision = await conflict({
        type: "restore",
        source:
          scope.kind === "project"
            ? path.relative(scope.root, record.originalAbsolute)
            : record.originalAbsolute,
        target,
        sourceType,
        targetType,
        targetRevision: selectedRevision,
        revision: selectedRevision,
        choices,
        revalidate: async () => {
          await trash.freshScope(scope);
          const fresh = await trash.observe(trash.authorized(scope, id));
          if (
            fresh.availability !== "recoverable" ||
            fresh.revision !== observed.revision
          )
            throw fileProblem("FILE_CONFLICT_CHANGED", 409);
          await trash.publisher.assertExpected(scope, target, selectedRevision, {
            expectedTarget: current.absolute,
          });
        },
      });
      if (decision.decision === "cancel") throw fileProblem("FILE_CANCELLED", 409);
      if (decision.decision === "skip") return null;
      if (decision.decision === "keep_both") {
        let index = 1,
          selected;
        do {
          signal.throwIfAborted();
          target = path.join(
            path.dirname(operation.target),
            alternateName(path.basename(operation.target), ++index),
          );
          selected = await resolveFile(scope, target, {
            followLeaf: false,
            allowMissingLeaf: true,
          });
        } while (selected.stat);
        expectedRevision = null;
      }
    }
  }
  // The payload is adopted exactly once. A publication race remains journaled;
  // retrying here could consume an already adopted or published source.
  return trash.restore(scope, id, target, {
    jobId,
    signal,
    expectedRevision,
    expectedTrashRevision: observed.revision,
  });
}
