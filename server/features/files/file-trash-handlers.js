import { registerFileJobHandler } from "./file-job-handlers.js";
import { resolveFile, entryRevision } from "./file-paths.js";
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
      async ({ scope, operation, jobId, signal, report, conflict }) => {
        if (kind === "purge") {
          // Validate the entire frozen selection before removing any member.
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
        for (let index = 0; index < operation.sources.length; index++) {
          signal.throwIfAborted();
          const source = operation.sources[index];
          if (kind === "trash")
            await trash.capture(scope, source, { jobId, reason: "deleted", signal });
          else if (kind === "purge")
            await trash.purge(scope, source, {
              jobId,
              confirmation: operation.options.confirmation[index],
              signal,
            });
          else {
            let expectedRevision = operation.options.expectedRevision;
            if (expectedRevision === undefined) {
              const current = await resolveFile(scope, operation.target, {
                followLeaf: false,
                allowMissingLeaf: true,
              });
              expectedRevision = current.stat
                ? entryRevision(current.stat, current.linkIdentity)
                : null;
              if (expectedRevision) {
                const selectedRevision = expectedRevision;
                const decision = await conflict({
                  type: "restore",
                  target: operation.target,
                  revision: expectedRevision,
                  choices: ["replace", "skip", "cancel"],
                  revalidate: () =>
                    trash.publisher.assertExpected(
                      scope,
                      operation.target,
                      selectedRevision,
                    ),
                });
                if (decision.decision === "cancel")
                  throw fileProblem("FILE_CANCELLED", 409);
                if (decision.decision === "skip") continue;
              }
            }
            await trash.restore(scope, source, operation.target, {
              jobId,
              expectedRevision,
              signal,
            });
          }
          await report({ completedEntries: index + 1 });
        }
      },
      { public: true, transfer: true, validate: validateTrashOperation },
    );
}
