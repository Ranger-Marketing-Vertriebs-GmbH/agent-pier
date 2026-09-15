import { registerFileJobHandler, safeIssue } from "./file-job-handlers.js";
import path from "node:path";
import { restoreSelection } from "./file-restore-conflict.js";
import { fileProblem } from "./file-errors.js";

export function validateTrashOperation(op) {
  if (
    !op.sources.length ||
    new Set(op.sources).size !== op.sources.length ||
    op.name !== null
  )
    return false;
  const keys = Object.keys(op.options);
  if (op.kind === "trash") return op.target === null && keys.length === 0;
  if (op.kind === "restore")
    return (
      op.sources.length === 1 &&
      typeof op.target === "string" &&
      keys.every((key) => key === "expectedRevision") &&
      (op.options.expectedRevision === undefined ||
        op.options.expectedRevision === null ||
        /^e1:[a-f0-9]{64}$/.test(op.options.expectedRevision))
    );
  if (
    op.kind !== "purge" ||
    op.target !== null ||
    keys.length !== 1 ||
    keys[0] !== "confirmation"
  )
    return false;
  const confirmation = op.options.confirmation;
  return (
    Array.isArray(confirmation) &&
    confirmation.length === op.sources.length &&
    confirmation.every(
      (item, index) =>
        item &&
        Object.keys(item).length === 2 &&
        item.id === op.sources[index] &&
        typeof item.revision === "string" &&
        /^t1:[a-f0-9]{64}$/.test(item.revision),
    )
  );
}
export function registerTrashHandlers(handlers, trash) {
  for (const kind of ["trash", "restore", "purge"])
    registerFileJobHandler(
      handlers,
      kind,
      async (context) => {
        const { scope, operation, jobId, signal, report } = context;
        const rows = operation.sources.map((source, index) => {
          const record = kind === "trash" ? null : trash.authorized(scope, source);
          const publicPath = record
            ? scope.kind === "project"
              ? path.relative(scope.root, record.originalAbsolute)
              : record.originalAbsolute
            : source;
          return {
            id: String(index),
            source,
            path: publicPath,
            name: path.basename(publicPath),
            type: record?.type,
            size: record?.size ?? null,
            status: "pending",
          };
        });
        const save = (row, patch) =>
          trash.barrier.run(() => {
            Object.assign(row, patch);
            trash.store.putEntry(jobId, row);
          });
        for (const row of rows) await save(row, {});
        await report({ totalEntries: rows.length });
        if (kind === "purge") {
          // Every submitted batch is fully preflighted before its first removal.
          for (const selected of operation.options.confirmation) {
            const record = trash.authorized(scope, selected.id),
              current = await trash.observe(record);
            if (
              current.availability !== "recoverable" ||
              current.revision !== selected.revision
            )
              throw fileProblem("FILE_TRASH_CONFIRMATION", 409);
          }
        }
        let completed = 0;
        for (let index = 0; index < operation.sources.length; index++) {
          signal.throwIfAborted();
          await trash.freshScope(scope);
          const source = operation.sources[index],
            row = rows[index];
          try {
            let result;
            if (kind === "trash") {
              const id = await trash.capture(scope, source, {
                jobId,
                reason: "deleted",
                signal,
                expectedSource: context.retry?.pins.find((pin) => pin.source === source),
              });
              const record = trash.authorized(scope, id);
              await save(row, { type: record.type, size: record.size });
            } else if (kind === "purge") {
              await trash.purge(scope, source, {
                jobId,
                confirmation: operation.options.confirmation[index],
                signal,
              });
            } else {
              result = await restoreSelection(trash, context);
              if (!result) {
                await save(row, { status: "skipped" });
                continue;
              }
            }
            await save(row, {
              status: "completed",
              sourceRemoved: true,
              ...(result
                ? {
                    path: result.path,
                    name: path.basename(result.path),
                    revision: result.revision,
                    outputPublished: true,
                  }
                : {}),
            });
            await report({ completedEntries: ++completed });
          } catch (error) {
            // Cancellation/progress failure after a durable removal cannot turn
            // the already completed entry back into an uncertain failure.
            if (!trash.store.getEntry(jobId, row.id)?.sourceRemoved)
              await save(row, { status: "failed", issue: error });
            if (completed && !signal.aborted)
              await trash.barrier.run(() => {
                const current = trash.store.getJob(scope, jobId);
                trash.store.transition(jobId, current.status, "partially_completed", {
                  issue: safeIssue(error),
                  conflict: null,
                });
              });
            throw error;
          }
        }
      },
      { public: true, transfer: true, validate: validateTrashOperation },
    );
}
