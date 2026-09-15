import path from "node:path";
import { fileProblem } from "./file-errors.js";
import { entryRevision, resolveFile } from "./file-paths.js";
import {
  openParent,
  ownedHandle,
  inodeIdentity,
  inspect,
  parentMatches,
  closeHandles,
} from "./file-stage.js";
import { scanTree, treeParent } from "./file-tree.js";
import { bindExtract, extractRows } from "./file-extract-store.js";

const changed = () => fileProblem("FILE_CONFLICT_CHANGED", 409);

export async function extractRevisions(store, record, native) {
  if (record.document.extractCompleted) return new Map();
  const doc = record.document,
    revisions = new Map();
  const selected = await resolveFile(doc.scope, doc.selectedPath, { followLeaf: false });
  const parent = await openParent(native, selected.absolute);
  try {
    if (
      selected.absolute !== doc.target ||
      inodeIdentity(await parent.stat()) !== doc.targetParent
    )
      throw changed();
    const actual = await scanTree(native, parent, path.basename(selected.absolute), {
      limits: store.limits,
    });
    const rows = extractRows(store, record.jobId, doc.extract.group);
    const expected = new Map(rows.map((row) => [row.groupRelative, row]));
    if (actual.length !== expected.size) throw changed();
    for (const item of actual) {
      const row = expected.get(item.relativePath),
        proof = row?.payload;
      if (
        !proof ||
        proof.phase !== "verified" ||
        proof.stageId !== record.id ||
        proof.identity !== item.identity ||
        proof.type !== item.type ||
        (item.relativePath
          ? proof.revision !== item.revision
          : proof.content !== item.content)
      )
        throw changed();
      revisions.set(row.id, item.revision);
    }
    return revisions;
  } finally {
    await parent.close();
  }
}
export async function reopenExtractStage(publisher, scope, id) {
  const record = publisher.store.getPublication(id),
    doc = record?.document;
  if (
    !doc?.extract ||
    doc.extract.role !== "output" ||
    !doc.extractValidated ||
    record.phase !== "staging" ||
    doc.scopeId !== scope.id ||
    doc.expectedIdentity !== undefined
  )
    throw changed();
  bindExtract(publisher.store, scope, record.jobId, doc.selectedPath, doc.extract);
  const state = {
    id,
    jobId: record.jobId,
    document: doc,
    scopeId: scope.id,
    type: doc.type,
    followLeaf: false,
    target: doc.target,
    selectedPath: doc.selectedPath,
    file: doc.staged,
    name: path.basename(doc.staged),
    targetName: path.basename(doc.target),
    directoryName: path.basename(path.dirname(doc.staged)),
  };
  try {
    state.targetParentHandle = await openParent(publisher.native, doc.target);
    state.parentHandle = await openParent(publisher.native, doc.staged);
    if (
      inodeIdentity(await state.targetParentHandle.stat()) !== doc.targetParent ||
      inodeIdentity(await state.parentHandle.stat()) !== doc.stageParent
    )
      throw changed();
    state.handle = ownedHandle(
      publisher.native,
      await publisher.native.run(doc.type === "directory" ? "openLookup" : "openFile", {
        directory: state.parentHandle.handle,
        path: state.name,
      }),
    );
    await verifyExtractStage(publisher, record, state.parentHandle, { publishing: true });
    return state;
  } catch (error) {
    await closeHandles(state.handle, state.parentHandle, state.targetParentHandle);
    throw error;
  }
}

export async function verifyExtractStage(
  publisher,
  record,
  parent,
  { publishing = false } = {},
) {
  const doc = record.document,
    role = doc.extract.role;
  const rows = extractRows(publisher.store, record.jobId, doc.extract.group, role);
  const evidence = new Map(
    rows
      .filter((row) => {
        const value = role === "probe" ? row.witness : row.payload;
        return value && !["not_created", "removed"].includes(value.phase);
      })
      .map((row) => [
        role === "probe" ? row.effectiveName : row.groupRelative,
        role === "probe" ? row.witness : row.payload,
      ]),
  );
  if (role === "probe" && doc.extractRoot?.phase !== "removed")
    evidence.set("", doc.extractRoot);
  const root = await inspect(publisher.native, parent.handle, path.basename(doc.staged));
  const actual = root
    ? await scanTree(publisher.native, parent, path.basename(doc.staged), {
        limits: {
          ...publisher.store.limits,
          jobEntries: publisher.store.limits.jobEntries + 1,
        },
      })
    : [];
  for (const item of actual) {
    const expected = evidence.get(item.relativePath);
    if (
      !expected ||
      expected.stageId !== record.id ||
      !["verified", "removing"].includes(expected.phase) ||
      item.identity !== expected.identity ||
      item.type !== expected.type ||
      ((publishing || item.type !== "directory") && item.revision !== expected.revision)
    )
      throw changed();
    evidence.delete(item.relativePath);
  }
  if ([...evidence.values()].some((value) => value.phase !== "removing")) throw changed();
  return actual;
}

function cleanupCheckpoint(publisher, record, indexed, relative, phase) {
  const doc = record.document,
    probe = doc.extract.role === "probe";
  if (probe && !relative) {
    doc.extractRoot = { ...doc.extractRoot, phase };
    publisher.store.putPublication(record);
  } else {
    const row = indexed.get(relative);
    const key = probe ? "witness" : "payload";
    row[key] = { ...row[key], phase };
    publisher.store.putEntry(record.jobId, row);
  }
}

// Called by the existing publisher/recovery lifecycle only. Registered intents and
// per-entry observations authorize finite cleanup; unknown or changed work is pinned.
export async function discardExtractStage(publisher, record) {
  const doc = record?.document;
  if (
    !doc?.extract ||
    doc.extractCompleted ||
    Object.hasOwn(doc, "expectedIdentity") ||
    !["staging", "interrupted"].includes(record.phase)
  )
    throw changed();
  let parent, targetParent;
  try {
    targetParent = await openParent(publisher.native, doc.target);
    if (inodeIdentity(await targetParent.stat()) !== doc.targetParent) throw changed();
    const container = await inspect(
      publisher.native,
      targetParent.handle,
      path.basename(path.dirname(doc.staged)),
    );
    if (!container && doc.extractCleanupComplete) {
      await publisher.barrier.run(() =>
        publisher.store.putPublication({
          ...record,
          phase: "resolved",
          document: { ...doc, extractDiscarded: true },
        }),
      );
      return;
    }
    parent = await openParent(publisher.native, doc.staged);
    if (
      inodeIdentity(await parent.stat()) !== doc.stageParent ||
      !(await parentMatches(publisher.native, doc.staged, doc.stageParent))
    )
      throw changed();
    const rows = await verifyExtractStage(publisher, record, parent);
    const indexed = new Map(
      extractRows(publisher.store, record.jobId, doc.extract.group, doc.extract.role).map(
        (row) => [
          doc.extract.role === "probe" ? row.effectiveName : row.groupRelative,
          row,
        ],
      ),
    );
    const actual = new Map(rows.map((row) => [row.relativePath, row]));
    for (const row of [...rows].reverse()) {
      const owner = await treeParent(
        publisher.native,
        parent,
        path.basename(doc.staged),
        row.relativePath,
        actual,
      );
      try {
        await publisher.locks.withPaths([doc.target], () =>
          publisher.barrier.run(async () => {
            if (
              !(await parentMatches(publisher.native, doc.target, doc.targetParent)) ||
              !(await parentMatches(publisher.native, doc.staged, doc.stageParent))
            )
              throw changed();
            const name = row.relativePath
              ? path.basename(row.relativePath)
              : path.basename(doc.staged);
            const current = await inspect(publisher.native, owner.handle, name);
            if (
              inodeIdentity(current) !== row.identity ||
              current.type !== row.type ||
              (row.type !== "directory" && entryRevision(current) !== row.revision)
            )
              throw changed();
            cleanupCheckpoint(publisher, record, indexed, row.relativePath, "removing");
            await publisher.native.run("removeEntry", {
              directory: owner.handle,
              name,
              identity: row.identity,
              type: row.type,
            });
            await owner.sync();
            cleanupCheckpoint(publisher, record, indexed, row.relativePath, "removed");
          }),
        );
      } finally {
        await owner.close();
      }
    }
    await publisher.locks.withPaths([doc.target], () =>
      publisher.barrier.run(async () => {
        if (!(await parentMatches(publisher.native, doc.target, doc.targetParent)))
          throw changed();
        doc.extractCleanupComplete = true;
        publisher.store.putPublication(record);
        await publisher.native.run("removeEntry", {
          directory: targetParent.handle,
          name: path.basename(path.dirname(doc.staged)),
          identity: doc.stageParent,
          type: "directory",
        });
        await targetParent.sync();
        publisher.store.putPublication({
          ...record,
          phase: "resolved",
          document: { ...doc, extractDiscarded: true },
        });
      }),
    );
  } finally {
    await closeHandles(parent, targetParent);
  }
}
