import path from "node:path";
import { retryTargetGuard } from "./file-retry-targets.js";
import { randomUUID } from "node:crypto";
import { FileMutations, alternateName } from "./file-mutations.js";
import { copyVerified, openTreeSource } from "./file-tree-transfer.js";
import { assertTree } from "./file-tree.js";
import { registerFileJobHandler } from "./file-job-handlers.js";
import {
  resolveFile,
  appendFilePath,
  entryRevision,
  assertFileMutationTarget,
  isWithin,
} from "./file-paths.js";
import { fileProblem, fileSystemProblem } from "./file-errors.js";
import { inodeIdentity, contentIdentity } from "./file-stage.js";
import { removeMergedSource } from "./file-merge-removal.js";
import {
  copyType,
  revisionOf,
  planCopies,
  validateCopyOperation,
} from "./file-copy-plan.js";

export class FileCopies extends FileMutations {
  constructor(options) {
    super(options);
    this.limits = options.limits;
    this.copy = copyVerified;
  }
  copyFiles(context) {
    return this.run(context);
  }
  moveFiles(context) {
    return this.run(context);
  }
  async run(context) {
    context.scope = await this.freshScope(context.scope);
    const items = await planCopies(this, context);
    const state = { writtenBytes: 0, failed: false, wildcard: new Map() };
    try {
      // Iterative work list; merging expands one existing directory at a time.
      for (let index = 0; index < items.length; index++) {
        context.signal.throwIfAborted();
        const item = items[index];
        if (item.error) {
          state.failed = true;
          await context.report({ issue: item.error });
          continue;
        }
        try {
          if (item.finishMerge) await this.finishMerge(context, item, state);
          else {
            const children = await this.transfer(context, item, state);
            if (children) items.splice(index + 1, 0, ...children);
          }
        } catch (error) {
          if (context.signal.aborted) throw error;
          state.failed = true;
          await this.rows(
            context,
            item.rows.filter(
              (row) =>
                !this.publisher.store.getEntry(context.jobId, row.id)?.outputPublished,
            ),
            { status: "failed", issue: fileSystemProblem(error) },
          );
          await context.report({ issue: fileSystemProblem(error) });
        }
      }
    } finally {
      await this.publisher.barrier.run(() => {
        const job = this.publisher.store.getJob(context.scope, context.jobId);
        const progress = this.publisher.store.refreshTransferProgress(context.jobId);
        if (progress.published && (state.failed || context.signal.aborted))
          this.publisher.store.transition(
            context.jobId,
            job.status,
            "partially_completed",
            { conflict: null },
          );
        else if (state.failed)
          this.publisher.store.transition(context.jobId, job.status, "failed", {
            conflict: null,
          });
      });
    }
  }
  rows(context, rows, patch) {
    return this.publisher.barrier.run(() => {
      for (const row of rows) {
        Object.assign(
          row,
          {
            ...this.publisher.store.getEntry(context.jobId, row.id),
            relativePath: row.relativePath,
            path: row.path,
          },
          patch,
        );
        if (patch.sourceRemoved)
          this.publisher.store.checkpointTransferEntry(context.jobId, row);
        else this.publisher.store.putEntry(context.jobId, row);
      }
    });
  }
  async validatePair(context, item, target, expectedRevision) {
    const scope = await this.freshScope(context.scope);
    const selected = item.selected;
    if (selected.stat.isDirectory()) {
      const opened = await openTreeSource(scope, item.source, this.publisher.native);
      try {
        await assertTree(this.publisher.native, opened.parent, opened.name, item.rows, {
          limits: this.limits,
          signal: context.signal,
          includeSpecial: true,
        });
      } finally {
        await opened.parent.close();
      }
    }
    await this.publisher.locks.withPaths(
      [selected.absolute, target.absolute],
      async () => {
        await this.freshScope(scope);
        const source = await resolveFile(scope, item.source, { followLeaf: false });
        const destination = await resolveFile(scope, target.path, {
          followLeaf: false,
          allowMissingLeaf: true,
        });
        if (
          source.absolute !== selected.absolute ||
          revisionOf(source) !== revisionOf(selected) ||
          destination.absolute !== target.absolute ||
          revisionOf(destination) !== expectedRevision
        )
          throw fileProblem("FILE_CONFLICT_CHANGED", 409);
      },
      context.signal,
    );
  }
  async transfer(context, item, state) {
    const { signal, operation } = context;
    let targetPath = item.target,
      alternate = 1,
      keepBoth = false;
    const type = copyType(item.selected.stat);
    if (type === "special") {
      state.failed = true;
      await this.rows(context, item.rows, {
        status: "skipped",
        issue: fileProblem("FILE_UNSUPPORTED_TYPE", 415),
      });
      return;
    }
    for (;;) {
      signal.throwIfAborted();
      const scope = await this.freshScope(context.scope);
      const target = await resolveFile(scope, targetPath, {
        followLeaf: false,
        allowMissingLeaf: true,
      });
      assertFileMutationTarget(scope, target);
      this.trash.assertProtected(target.absolute);
      if (
        target.absolute === item.selected.absolute ||
        (type === "directory" && isWithin(item.selected.absolute, target.absolute)) ||
        (target.stat && inodeIdentity(target.stat) === inodeIdentity(item.selected.stat))
      )
        throw fileProblem("FILE_SAME_PATH", 409);
      const expectedRevision = revisionOf(target),
        targetType = copyType(target.stat);
      if (expectedRevision && keepBoth) {
        targetPath = appendFilePath(
          path.dirname(item.target),
          alternateName(path.basename(item.target), ++alternate),
        );
        continue;
      }
      if (expectedRevision) {
        const choices =
          type === "directory" && targetType === "directory"
            ? ["merge", "skip", "keep_both", "cancel"]
            : type === targetType
              ? ["replace", "skip", "keep_both", "cancel"]
              : ["skip", "keep_both", "cancel"];
        const signature = `${type}:${targetType}`;
        let decision = state.wildcard.get(signature);
        if (
          !decision ||
          item.rows[0].initialTarget !== expectedRevision ||
          !choices.includes(decision.decision)
        ) {
          decision = await context.conflict({
            type: "name",
            sourceType: type,
            targetType,
            source: item.source,
            target: targetPath,
            sourceRevision: revisionOf(item.selected),
            targetRevision: expectedRevision,
            choices,
            revalidate: () => this.validatePair(context, item, target, expectedRevision),
          });
          if (decision.applyToRemaining) state.wildcard.set(signature, decision);
        }
        await this.validatePair(context, item, target, expectedRevision);
        if (decision.decision === "cancel") throw fileProblem("FILE_CANCELLED", 409);
        if (decision.decision === "skip") {
          await this.rows(context, item.rows, { status: "skipped" });
          return;
        }
        if (decision.decision === "keep_both") {
          keepBoth = true;
          targetPath = appendFilePath(
            path.dirname(item.target),
            alternateName(path.basename(item.target), ++alternate),
          );
          continue;
        }
        if (decision.decision === "merge") return this.merge(context, item, target);
      }
      await this.validatePair(context, item, target, expectedRevision);
      const transferId = randomUUID();
      for (const row of item.rows)
        row.path = appendFilePath(targetPath, row.relativePath);
      await this.rows(context, item.rows, { transferId });
      let result;
      try {
        if (
          operation.kind === "move" &&
          !item.rows.some((row) => row.type === "special")
        ) {
          try {
            result = await this.publisher.rename(scope, item.source, targetPath, {
              jobId: context.jobId,
              sourceRevision: revisionOf(item.selected),
              expectedRevision,
              signal,
              refreshScope: () => this.freshScope(scope),
              transferId,
              targetGuard: retryTargetGuard(context),
            });
          } catch (error) {
            if (
              error.recoveryId &&
              (await this.trash.retainRenameSource(scope, error.recoveryId))
            )
              throw fileProblem("FILE_RENAME_RECOVERY", 409);
            if (!error.crossDeviceSafe) throw error;
          }
        }
        if (!result)
          result = await this.copyEntry(
            context,
            item,
            targetPath,
            expectedRevision,
            transferId,
            state,
          );
      } catch (error) {
        if (
          expectedRevision === null &&
          !item.rows.some(
            (row) =>
              this.publisher.store.getEntry(context.jobId, row.id)?.outputPublished,
          ) &&
          ["FILE_EXISTS", "FILE_CONFLICT_CHANGED"].includes(error.code)
        ) {
          const occupied = await resolveFile(scope, targetPath, {
            followLeaf: false,
            allowMissingLeaf: true,
          });
          if (occupied.stat) {
            const restored =
              error.recoveryId &&
              this.publisher.store.getPublication(error.recoveryId)?.document
                .renameSource;
            if (operation.kind === "move" && restored?.disposition === "restored") {
              const source = await resolveFile(scope, item.source, { followLeaf: false });
              if (
                source.absolute !== item.selected.absolute ||
                inodeIdentity(source.stat) !== restored.identity ||
                contentIdentity(source.stat) !== restored.content
              )
                throw fileProblem("FILE_CONFLICT_CHANGED", 409);
              item.selected = source;
              item.rows[0].revision = entryRevision(source.stat);
            }
            continue;
          }
        }
        throw error;
      }
      if (result.recoveryId) await this.trash.adoptDisplaced(scope, result.recoveryId);
      // Mark memory too; durable completion is performed before publisher resolution.
      for (const row of item.rows)
        Object.assign(row, this.publisher.store.getEntry(context.jobId, row.id));
      if (item.rows.some((row) => row.type === "special")) state.failed = true;
      return;
    }
  }
  async copyEntry(context, item, targetPath, expectedRevision, transferId, state) {
    const { scope, signal, jobId, operation } = context;
    const stage = await this.publisher.stage(scope, targetPath, {
      jobId,
      type: copyType(item.selected.stat),
      transferId,
      targetGuard: retryTargetGuard(context),
    });
    let published = false,
      uncertain = false;
    try {
      const transferred = await this.copy(scope, item.source, stage, {
        limits: this.limits,
        signal,
        strictMetadata: operation.kind === "move",
        includeSpecial: true,
        reportBytes: async (bytes) => {
          state.writtenBytes += bytes;
          if (state.writtenBytes > this.limits.jobBytes)
            throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
        },
        report: async ({ entry, issue }) => {
          if (issue) await context.report({ issue });
          if (entry) {
            const row = item.rows.find((row) => row.relativePath === entry.relativePath);
            if (entry.phase === "creating" && row.revision !== entry.revision)
              throw fileProblem("FILE_CONFLICT_CHANGED", 409);
            await this.rows(
              context,
              [row],
              entry.removed
                ? { removed: true, sourceRemoved: true, status: "completed" }
                : entry,
            );
          }
        },
        mutate: (fn) =>
          this.publisher.locks.withPaths(
            [item.selected.absolute],
            () =>
              this.publisher.barrier.run(async () => {
                await this.freshScope(scope);
                signal.throwIfAborted();
                await fn();
              }),
            signal,
          ),
        cleanupMutate: (fn) =>
          this.publisher.locks.withPaths([stage.target], () =>
            this.publisher.barrier.run(fn),
          ),
      });
      await transferred.assertSourceUnchanged();
      published = true;
      const result = await this.publisher.publish(scope, stage, {
        expectedRevision,
        refreshScope: () => this.freshScope(scope),
        beforeMutation: () => signal.throwIfAborted(),
      });
      if (result.recoveryId) await this.trash.adoptDisplaced(scope, result.recoveryId);
      if (operation.kind === "move") {
        await transferred.assertSourceUnchanged();
        await transferred.removeMatchingSource();
      }
      return { ...result, recoveryId: null };
    } catch (error) {
      uncertain = error.copyCleanupUncertain === true;
      if (published) await this.publisher.discard(stage).catch(() => {});
      throw error;
    } finally {
      if (!published && uncertain) await this.publisher.release(stage);
      else if (!published)
        await this.publisher
          .discard(stage)
          .catch(() => this.publisher.release(stage).catch(() => {}));
    }
  }
  async merge(context, item, target) {
    const issue = { code: "FILE_MERGE_METADATA_RETAINED", args: {} };
    await this.rows(context, [item.rows[0]], { issue });
    await context.report({ issue });
    const children = [];
    for (const row of item.rows.filter(
      (row) => row.relativePath && !row.relativePath.includes("/"),
    )) {
      const rows = item.rows
        .filter(
          (child) =>
            child === row || child.relativePath.startsWith(row.relativePath + "/"),
        )
        .map((child) => ({
          ...child,
          relativePath: path.relative(row.relativePath, child.relativePath),
        }));
      const source = appendFilePath(item.source, row.relativePath);
      const selected = await resolveFile(context.scope, source, { followLeaf: false });
      if (entryRevision(selected.stat) !== row.revision)
        throw fileProblem("FILE_CONFLICT_CHANGED", 409);
      children.push({
        source,
        selected,
        target: appendFilePath(target.path, row.relativePath),
        rows,
      });
    }
    return [
      ...children,
      {
        ...item,
        rows: [item.rows[0]],
        finishMerge: true,
        target: target.path,
        mergeTarget: inodeIdentity(target.stat),
        mergeTargetAbsolute: target.absolute,
        mergeChildren: children.map((child) => child.rows[0].id),
      },
    ];
  }
  async finishMerge(context, item) {
    const scope = await this.freshScope(context.scope);
    const source = await resolveFile(scope, item.source, { followLeaf: false });
    if (
      source.absolute !== item.selected.absolute ||
      inodeIdentity(source.stat) !== inodeIdentity(item.selected.stat)
    )
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    const target = await resolveFile(scope, item.target, { followLeaf: false });
    if (
      target.absolute !== item.mergeTargetAbsolute ||
      inodeIdentity(target.stat) !== item.mergeTarget
    )
      throw fileProblem("FILE_CONFLICT_CHANGED", 409);
    if (context.operation.kind === "move") {
      // Preserve an unresolved child's original parent so restart can prove absence.
      if (
        item.mergeChildren.some(
          (id) => !this.publisher.store.getEntry(context.jobId, id)?.sourceRemoved,
        )
      ) {
        await this.rows(context, item.rows, {
          path: item.target,
          outputPublished: true,
          sourceRemoved: false,
          sourceRemovalPending: false,
          status: "published",
          revision: revisionOf(target),
        });
        throw fileProblem("FILE_INTERRUPTED", 409);
      }
      return removeMergedSource(this, context, item, source, target);
    }
    await this.rows(context, item.rows, {
      status: "completed",
      outputPublished: true,
      sourceRemoved: context.operation.kind === "move",
      path: item.target,
      name: path.basename(item.target),
      revision: revisionOf(target),
    });
    await this.publisher.barrier.run(() =>
      this.publisher.store.refreshTransferProgress(context.jobId),
    );
  }
}

export function registerCopyHandlers(handlers, copies) {
  for (const [kind, method] of [
    ["copy", "copyFiles"],
    ["move", "moveFiles"],
  ])
    registerFileJobHandler(handlers, kind, (context) => copies[method](context), {
      public: true,
      transfer: true,
      readOnly: false,
      validate: validateCopyOperation,
    });
}
