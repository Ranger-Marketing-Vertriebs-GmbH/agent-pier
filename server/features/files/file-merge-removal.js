import path from "node:path";
import { randomUUID } from "node:crypto";
import { resolveFile, entryRevision, assertFileMutationTarget } from "./file-paths.js";
import {
  openParent,
  inspect,
  inodeIdentity,
  contentIdentity,
  parentMatches,
  closeHandles,
} from "./file-stage.js";
import { fileProblem } from "./file-errors.js";

const changed = () => fileProblem("FILE_CONFLICT_CHANGED", 409);
const revisionOf = (entry) => entryRevision(entry.stat, entry.linkIdentity);

async function inspectRemoval(native, doc, sourceParent, targetParent) {
  const proof = doc.mergeRemoval;
  if (
    !(await parentMatches(native, proof.sourceAbsolute, proof.sourceParent)) ||
    !(await parentMatches(native, doc.target, doc.targetParent)) ||
    inodeIdentity(await sourceParent.stat()) !== proof.sourceParent ||
    inodeIdentity(await targetParent.stat()) !== doc.targetParent
  )
    throw changed();
  const source = await resolveFile(doc.scope, proof.source, {
    followLeaf: false,
    allowMissingLeaf: true,
  });
  const target = await resolveFile(doc.scope, doc.selectedPath, { followLeaf: false });
  assertFileMutationTarget(doc.scope, source);
  assertFileMutationTarget(doc.scope, target);
  const actualSource = await inspect(
    native,
    sourceParent.handle,
    path.basename(proof.sourceAbsolute),
  );
  const actualTarget = await inspect(
    native,
    targetParent.handle,
    path.basename(doc.target),
  );
  if (
    source.absolute !== proof.sourceAbsolute ||
    source.linkIdentity !== proof.sourceLinkIdentity ||
    target.absolute !== doc.target ||
    target.linkIdentity !== doc.linkIdentity ||
    inodeIdentity(target.stat) !== doc.targetIdentity ||
    actualTarget?.type !== "directory" ||
    inodeIdentity(actualTarget) !== doc.targetIdentity ||
    entryRevision(actualTarget) !== entryRevision(target.stat) ||
    inodeIdentity(actualSource) !== inodeIdentity(source.stat) ||
    (actualSource &&
      (actualSource.type !== "directory" ||
        entryRevision(actualSource) !== entryRevision(source.stat)))
  )
    throw changed();
  return { source, target, actualSource };
}

function checkpoint(store, record, row, removed) {
  store.checkpointTransferEntry(
    record.jobId,
    {
      ...row,
      path: record.document.selectedPath,
      name: path.basename(record.document.selectedPath),
      outputPublished: true,
      sourceRemoved: removed,
      sourceRemovalPending: false,
      status: removed ? "completed" : "published",
    },
    {
      ...record,
      phase: "resolved",
      document: {
        ...record.document,
        mergeRemoval: {
          ...record.document.mergeRemoval,
          disposition: removed ? "removed" : "retained",
        },
      },
    },
  );
}

/** Journal an existing merged destination and removal intent before the syscall.
 * Entry, counters and completion marker commit together under the source lease. */
export async function removeMergedSource(owner, context, item, source, target) {
  const { publisher } = owner,
    { store, native, locks, barrier } = publisher;
  let sourceParent, targetParent;
  try {
    sourceParent = await openParent(native, source.absolute);
    targetParent = await openParent(native, target.absolute);
    const record = {
      id: randomUUID(),
      jobId: context.jobId,
      phase: "merge_removing",
      document: {
        version: 1,
        scopeId: context.scope.id,
        scope: { ...context.scope },
        target: target.absolute,
        selectedPath: target.path,
        targetIdentity: inodeIdentity(target.stat),
        targetParent: inodeIdentity(await targetParent.stat()),
        linkIdentity: target.linkIdentity,
        mergeRemoval: {
          entryId: item.rows[0].id,
          source: source.path,
          sourceAbsolute: source.absolute,
          identity: inodeIdentity(source.stat),
          sourceParent: inodeIdentity(await sourceParent.stat()),
          sourceLinkIdentity: source.linkIdentity,
          sourceRevision: revisionOf(source),
          targetRevision: revisionOf(target),
          targetContent: contentIdentity(target.stat),
          disposition: "pending",
        },
      },
    };
    await locks.withPaths(
      [source.absolute, target.absolute],
      () =>
        barrier.run(async () => {
          await owner.freshScope(context.scope);
          context.signal.throwIfAborted();
          const current = await inspectRemoval(
            native,
            record.document,
            sourceParent,
            targetParent,
          );
          if (
            !current.source.stat ||
            revisionOf(current.source) !== record.document.mergeRemoval.sourceRevision ||
            revisionOf(current.target) !== record.document.mergeRemoval.targetRevision
          )
            throw changed();
          const row = {
            ...store.getEntry(context.jobId, item.rows[0].id),
            path: target.path,
            name: path.basename(target.path),
            revision: revisionOf(current.target),
            outputPublished: true,
            sourceRemoved: false,
            sourceRemovalPending: true,
            status: "published",
          };
          store.checkpointTransferEntry(context.jobId, row, record);
          await owner.freshScope(context.scope);
          context.signal.throwIfAborted();
          const immediate = await inspectRemoval(
            native,
            record.document,
            sourceParent,
            targetParent,
          );
          if (
            !immediate.source.stat ||
            revisionOf(immediate.source) !==
              record.document.mergeRemoval.sourceRevision ||
            revisionOf(immediate.target) !== record.document.mergeRemoval.targetRevision
          )
            throw changed();
          await native.run("removeEntry", {
            directory: sourceParent.handle,
            name: path.basename(source.absolute),
            identity: record.document.mergeRemoval.identity,
            type: "directory",
          });
          await sourceParent.sync();
          await targetParent.sync();
          checkpoint(store, record, row, true);
        }),
      context.signal,
    );
  } finally {
    await closeHandles(sourceParent, targetParent);
  }
}

/** Existing startup reconciliation records proven absence, never retries deletion. */
export async function recoverMergedSource({ store, native, record, write }) {
  const doc = record.document,
    proof = doc.mergeRemoval;
  let sourceParent, targetParent;
  try {
    const job = store.getJob(doc.scope, record.jobId),
      row = store.getEntry(record.jobId, proof.entryId);
    if (
      doc.version !== 1 ||
      doc.scopeId !== doc.scope.id ||
      job.kind !== "move" ||
      !row ||
      row.type !== "directory" ||
      row.source !== proof.source ||
      row.path !== doc.selectedPath ||
      !row.outputPublished ||
      row.sourceRemoved ||
      !row.sourceRemovalPending ||
      row.identity !== proof.identity ||
      proof.disposition !== "pending"
    )
      throw changed();
    sourceParent = await openParent(native, proof.sourceAbsolute);
    targetParent = await openParent(native, doc.target);
    await write(async () => {
      const observed = await inspectRemoval(native, doc, sourceParent, targetParent);
      // Existing targets may be renamed away and back: retain stable stat proof
      // while excluding that rename's ctime. Missing historical proof stays pinned.
      if (
        contentIdentity(observed.target.stat) !== proof.targetContent ||
        (observed.actualSource &&
          (inodeIdentity(observed.actualSource) !== proof.identity ||
            revisionOf(observed.source) !== proof.sourceRevision))
      )
        throw changed();
      const removed = !observed.actualSource;
      await sourceParent.sync();
      await targetParent.sync();
      checkpoint(store, record, row, removed);
    });
    return { id: record.id, phase: "resolved", recoveryId: null, issue: null };
  } catch {
    const issue = { code: "FILE_INTERRUPTED", args: {} };
    await write(() =>
      store.putPublication({
        ...record,
        phase: "interrupted",
        document: { ...doc, issue },
      }),
    );
    return { id: record.id, phase: "interrupted", recoveryId: record.id, issue };
  } finally {
    await closeHandles(sourceParent, targetParent);
  }
}
