import path from "node:path";
import { randomUUID } from "node:crypto";
import { registerFileJobHandler } from "./file-job-handlers.js";
import {
  resolveFile,
  entryRevision,
  validateFileName,
  assertFileMutationTarget,
} from "./file-paths.js";
import { inodeIdentity, contentIdentity } from "./file-stage.js";
import { fileProblem } from "./file-errors.js";
import { assertRetryDestinations, retryTargetGuard } from "./file-retry-targets.js";

export function validateMutationOperation(op) {
  validateFileName(op.name);
  if (["create_file", "create_directory"].includes(op.kind))
    return (
      op.sources.length === 0 &&
      typeof op.target === "string" &&
      Object.keys(op.options).length === 0
    );
  if (
    op.kind !== "rename" ||
    op.sources.length !== 1 ||
    op.target !== null ||
    Object.keys(op.options).length !== 1
  )
    return false;
  const revisions = op.options.revisions;
  return (
    revisions &&
    typeof revisions === "object" &&
    !Array.isArray(revisions) &&
    Object.keys(revisions).length === 1 &&
    Object.hasOwn(revisions, op.sources[0]) &&
    typeof revisions[op.sources[0]] === "string" &&
    /^e1:[a-f0-9]{64}$/.test(revisions[op.sources[0]])
  );
}

export function alternateName(name, index) {
  const extension = path.extname(name),
    suffix = ` (${index})`;
  const budget = 255 - Buffer.byteLength(extension + suffix);
  if (budget < 1) throw fileProblem("FILE_INVALID_NAME", 400);
  let stem = "";
  for (const point of name.slice(0, name.length - extension.length)) {
    if (Buffer.byteLength(stem + point) > budget) break;
    stem += point;
  }
  return validateFileName(stem + suffix + extension);
}
const typeOf = (stat) =>
  stat?.isDirectory()
    ? "directory"
    : stat?.isSymbolicLink()
      ? "symlink"
      : stat?.isFile()
        ? "file"
        : "special";

export class FileMutations {
  constructor({ publisher, trash, locks, native, context }) {
    Object.assign(this, { publisher, trash, locks, native, context });
  }
  async freshScope(scope) {
    const fresh = this.context ? await this.context(scope.sessionId) : scope;
    if (fresh.id !== scope.id) throw fileProblem("FILE_INVALID_SCOPE", 409);
    if (fresh.readOnly) throw fileProblem("FILE_READ_ONLY", 403);
    return fresh;
  }
  createFile(context) {
    return this.mutate(context, "file");
  }
  createDirectory(context) {
    return this.mutate(context, "directory");
  }
  rename(context) {
    return this.mutate(context, null);
  }
  async mutate(context, creationType) {
    let { scope } = context;
    const { operation, jobId, signal, report, conflict } = context;
    if (!validateMutationOperation(operation))
      throw fileProblem("FILE_INVALID_OPERATION", 400);
    scope = await this.freshScope(scope);
    await assertRetryDestinations({ ...context, scope });
    signal.throwIfAborted();
    const sourcePath = creationType ? null : operation.sources[0];
    let sourceRevision = sourcePath ? operation.options.revisions[sourcePath] : null;
    const source = sourcePath
      ? await this.publisher.assertExpected(scope, sourcePath, sourceRevision)
      : null;
    const type = creationType || typeOf(source.stat);
    if (type === "special") throw fileProblem("FILE_UNSUPPORTED_TYPE", 415);
    if (source) this.trash.assertProtected(source.absolute);
    const parent = creationType ? operation.target : path.dirname(source.path);
    let target = path.join(parent, operation.name),
      index = 1,
      keepBoth = false;
    if (source && target === source.path) throw fileProblem("FILE_SAME_PATH", 409);
    for (;;) {
      signal.throwIfAborted();
      scope = await this.freshScope(scope);
      if (sourcePath)
        await this.publisher.assertExpected(scope, sourcePath, sourceRevision, {
          expectedTarget: source.absolute,
        });
      const selected = await resolveFile(scope, target, {
        followLeaf: false,
        allowMissingLeaf: true,
      });
      assertFileMutationTarget(scope, selected);
      this.trash.assertProtected(selected.absolute);
      const sameEntry =
        source &&
        selected.stat &&
        source.stat.dev === selected.stat.dev &&
        source.stat.ino === selected.stat.ino;
      let expectedRevision = selected.stat
        ? entryRevision(selected.stat, selected.linkIdentity)
        : null;
      if (expectedRevision && keepBoth) {
        target = path.join(parent, alternateName(operation.name, ++index));
        continue;
      }
      if (expectedRevision && !sameEntry) {
        const choices =
          type !== "directory" && typeOf(selected.stat) === type
            ? ["replace", "skip", "keep_both", "cancel"]
            : ["skip", "keep_both", "cancel"];
        const decision = await conflict({
          type: "name",
          sourceType: type,
          targetType: typeOf(selected.stat),
          source: sourcePath,
          target,
          sourceRevision,
          targetRevision: expectedRevision,
          choices,
          revalidate: async () => {
            await this.freshScope(scope);
            if (sourcePath)
              await this.publisher.assertExpected(scope, sourcePath, sourceRevision, {
                expectedTarget: source.absolute,
              });
            await this.publisher.assertExpected(scope, target, expectedRevision, {
              expectedTarget: selected.absolute,
            });
          },
        });
        if (decision.decision === "cancel") throw fileProblem("FILE_CANCELLED", 409);
        if (decision.decision === "skip") return;
        if (decision.decision === "keep_both") {
          keepBoth = true;
          target = path.join(parent, alternateName(operation.name, ++index));
          continue;
        }
        if (decision.decision !== "replace" || !choices.includes("replace"))
          throw fileProblem("FILE_INVALID_OPERATION", 400);
      }
      scope = await this.freshScope(scope);
      signal.throwIfAborted();
      let result;
      try {
        if (sourcePath) {
          result = await this.publisher.rename(scope, sourcePath, target, {
            jobId,
            sourceRevision,
            expectedRevision,
            signal,
            refreshScope: () => this.freshScope(scope),
            targetGuard: retryTargetGuard(context),
          });
        } else {
          const stage = await this.publisher.stage(scope, target, {
            jobId,
            type,
            followLeaf: false,
            targetGuard: retryTargetGuard(context),
          });
          let started = false;
          try {
            await this.freshScope(scope);
            signal.throwIfAborted();
            started = true;
            result = await this.publisher.publish(scope, stage, {
              expectedRevision,
              refreshScope: () => this.freshScope(scope),
              beforeMutation: () => signal.throwIfAborted(),
            });
          } finally {
            if (!started) await this.publisher.discard(stage);
          }
        }
      } catch (error) {
        if (sourcePath && error.recoveryId) {
          const retained = await this.trash.retainRenameSource(scope, error.recoveryId);
          if (retained) throw fileProblem("FILE_RENAME_RECOVERY", 409);
        }
        if (
          expectedRevision === null &&
          ["FILE_EXISTS", "FILE_CONFLICT_CHANGED"].includes(error.code)
        ) {
          const occupied = await resolveFile(scope, target, {
            followLeaf: false,
            allowMissingLeaf: true,
          });
          if (occupied.stat) {
            const restored =
              error.recoveryId &&
              this.publisher.store.getPublication(error.recoveryId)?.document
                .renameSource;
            if (sourcePath && restored?.disposition === "restored") {
              const current = await resolveFile(scope, sourcePath, { followLeaf: false });
              if (
                current.absolute !== source.absolute ||
                inodeIdentity(current.stat) !== restored.identity ||
                contentIdentity(current.stat) !== restored.content
              )
                throw fileProblem("FILE_CONFLICT_CHANGED", 409);
              sourceRevision = entryRevision(current.stat, current.linkIdentity);
            }
            continue;
          }
        }
        throw error;
      }
      if (result.recoveryId) await this.trash.adoptDisplaced(scope, result.recoveryId);
      await this.publisher.barrier.run(() =>
        this.publisher.store.putEntry(jobId, {
          id: randomUUID(),
          path: result.path,
          name: path.basename(result.path),
          type,
          status: "completed",
          revision: result.revision,
        }),
      );
      await report({ completedEntries: 1 });
      return result;
    }
  }
}

export function registerMutationHandlers(handlers, mutations) {
  for (const [kind, method] of [
    ["create_file", "createFile"],
    ["create_directory", "createDirectory"],
    ["rename", "rename"],
  ])
    registerFileJobHandler(handlers, kind, (context) => mutations[method](context), {
      public: true,
      transfer: false,
      readOnly: false,
      validate: validateMutationOperation,
    });
}
