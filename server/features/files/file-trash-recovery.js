import path from "node:path";
import { inodeIdentity, inspect, openParent } from "./file-stage.js";
import { scanTree, assertTree, removeTree, treeConflict } from "./file-tree.js";
import { openTreeSource } from "./file-tree-transfer.js";
import { openTrashPayload } from "./file-trash-storage.js";

function stable(rows, expected) {
  if (!expected || rows.length !== expected.length) throw treeConflict();
  for (const row of rows) {
    const old = expected.find((item) => item.relativePath === row.relativePath);
    if (
      !old ||
      row.content !== old.content ||
      (row.relativePath && row.revision !== old.revision)
    )
      throw treeConflict();
  }
}
async function remaining(trash, record, source) {
  const rows = await scanTree(trash.native, source.parent, source.name, {
    limits: trash.limits,
  });
  const removed = new Set(
    trash.store
      .trashItems(record.id)
      .filter((row) => row.removed)
      .map((row) => row.relativePath),
  );
  const expected = record.payloadManifest.filter((row) => !removed.has(row.relativePath));
  if (rows.length !== expected.length) throw treeConflict();
  for (const row of rows) {
    const old = expected.find((item) => item.relativePath === row.relativePath);
    if (
      !old ||
      row.identity !== old.identity ||
      (row.type !== "directory" && row.revision !== old.revision)
    )
      throw treeConflict();
  }
  return rows;
}
async function recoverEntry(trash, record) {
  if (record.phase === "recoverable") {
    if (!record.removalPending) return;
    const parent = await openParent(trash.native, record.originalAbsolute);
    try {
      if (inodeIdentity(await parent.stat()) !== record.sourceParentIdentity)
        throw treeConflict();
      const name = path.basename(record.originalAbsolute);
      const stat = await inspect(trash.native, parent.handle, name);
      if (!stat) {
        if (
          !trash.store
            .trashItems(record.id)
            .some((row) => !row.relativePath && row.removed)
        )
          throw treeConflict();
      } else {
        if (inodeIdentity(stat) !== record.sourceManifest[0].identity)
          throw treeConflict();
        const rows = await remaining(
          trash,
          { ...record, payloadManifest: record.sourceManifest },
          { parent, name },
        );
        await removeTree(trash.native, parent, name, rows, {
          limits: trash.limits,
          mutate: (fn) => trash.barrier.run(fn),
          report: ({ entry }) =>
            trash.store.putTrashItem(record.id, entry.relativePath, entry),
        });
      }
      record.removalPending = false;
      await trash.save(record);
    } finally {
      await parent.close();
    }
    return;
  }
  if (record.phase === "adoption_pending") {
    if (
      record.location?.file === record.centralLocation?.file &&
      record.location.identity === record.sourceManifest?.[0].identity
    ) {
      const source = await openTrashPayload(trash.native, record);
      try {
        const rows = await scanTree(trash.native, source.parent, source.name, {
          limits: trash.limits,
        });
        stable(rows, record.sourceManifest);
        const old = record.adoptionSource,
          parent = await openParent(trash.native, path.dirname(old.file));
        try {
          await trash.barrier.run(async () => {
            await source.parent.sync();
            await trash.native.run("removeEntry", {
              directory: parent.handle,
              name: path.basename(path.dirname(old.file)),
              identity: old.parentIdentity,
              type: "directory",
            });
            await parent.sync();
            record.payloadManifest = rows;
            record.phase = "recoverable";
            await trash.save(record);
            const publication = trash.store.getPublication(record.recoveryId);
            trash.store.putPublication({ ...publication, phase: "resolved" });
          });
        } finally {
          await parent.close();
        }
      } finally {
        await source.parent.close();
      }
      return;
    }
    await trash.adoptDisplaced(record.scope, record.recoveryId);
    return;
  }
  if (record.phase === "restore_pending") {
    const publication = trash.store.getPublication(record.restoreStage);
    if (!publication) throw treeConflict();
    const doc = publication.document;
    if (["resolved", "swapped"].includes(publication.phase)) {
      const parent = await openParent(trash.native, doc.target);
      try {
        if (
          inodeIdentity(
            await inspect(trash.native, parent.handle, path.basename(doc.target)),
          ) !== doc.stagedIdentity
        )
          throw treeConflict();
      } finally {
        await parent.close();
      }
      if (publication.phase === "swapped")
        await trash.adoptDisplaced(record.scope, publication.id);
      if (record.location.file !== record.restoreSourceLocation.file)
        record.location = record.restoreSourceLocation;
      if (record.restoreRemovalPending) {
        const source = await openParent(trash.native, record.location.file);
        try {
          if (inodeIdentity(await source.stat()) !== record.location.parentIdentity)
            throw treeConflict();
          const name = path.basename(record.location.file),
            stat = await inspect(trash.native, source.handle, name);
          if (stat) {
            if (inodeIdentity(stat) !== record.location.identity) throw treeConflict();
            const rows = await remaining(trash, record, { parent: source, name });
            await removeTree(trash.native, source, name, rows, {
              limits: trash.limits,
              mutate: (fn) => trash.barrier.run(fn),
              report: ({ entry }) =>
                trash.store.putTrashItem(record.id, entry.relativePath, entry),
            });
          } else if (
            !trash.store
              .trashItems(record.id)
              .some((row) => !row.relativePath && row.removed)
          )
            throw treeConflict();
          record.restoreRemovalPending = false;
          await trash.save(record);
        } finally {
          await source.close();
        }
      }
      await trash.finish(record);
      return;
    }
    // If adoption never moved the source, prove both the original payload and
    // the registered empty initial stage before disposing that failed stage.
    const original = await openTrashPayload(trash.native, {
      ...record,
      location: record.restoreSourceLocation,
    }).catch(() => null);
    if (original) {
      let parent;
      try {
        const rows = await scanTree(trash.native, original.parent, original.name, {
          limits: trash.limits,
        });
        stable(rows, record.payloadManifest);
        parent = await openParent(trash.native, doc.staged);
        if (inodeIdentity(await parent.stat()) !== doc.stageParent) throw treeConflict();
        const staged = await inspect(
          trash.native,
          parent.handle,
          path.basename(doc.staged),
        );
        const cloneRows = staged
          ? await scanTree(trash.native, parent, path.basename(doc.staged), {
              limits: trash.limits,
            })
          : [];
        const recorded = new Map(
          trash.store
            .trashItems(record.id)
            .map((row) => [row.relativePath, row.targetIdentity]),
        );
        if (staged && (staged.type !== "file" || staged.size === 0n))
          recorded.set("", doc.initialIdentity || doc.stagedIdentity);
        if (cloneRows.some((row) => recorded.get(row.relativePath) !== row.identity))
          throw treeConflict();
        if (staged)
          await removeTree(trash.native, parent, path.basename(doc.staged), cloneRows, {
            limits: trash.limits,
            mutate: (fn) => trash.barrier.run(fn),
          });
        await trash.barrier.run(async () => {
          await parent.sync();
          const outer = await openParent(trash.native, path.dirname(doc.staged));
          try {
            await trash.native.run("removeEntry", {
              directory: outer.handle,
              name: path.basename(path.dirname(doc.staged)),
              identity: doc.stageParent,
              type: "directory",
            });
            await outer.sync();
          } finally {
            await outer.close();
          }
          trash.store.putPublication({ ...publication, phase: "resolved" });
          record.location = record.restoreSourceLocation;
          record.payloadManifest = rows;
          record.phase = "recoverable";
          await trash.save(record);
        });
      } finally {
        await original.parent.close();
        await parent?.close();
      }
      return;
    }
    const identity = doc.adoptionSource?.identity;
    if (!identity) throw treeConflict();
    const location = { file: doc.staged, parentIdentity: doc.stageParent, identity };
    const opened = await openTrashPayload(trash.native, { ...record, location });
    try {
      const rows = await scanTree(trash.native, opened.parent, opened.name, {
        limits: trash.limits,
      });
      stable(rows, record.payloadManifest);
      if (
        record.restoreSourceLocation &&
        record.restoreSourceLocation.file !== location.file
      )
        record.extraLocations = [
          ...(record.extraLocations || []),
          record.restoreSourceLocation,
        ];
      record.location = location;
      record.payloadManifest = rows;
      record.phase = "recoverable";
      record.recoveryId = publication.id;
      await trash.save(record);
    } finally {
      await opened.parent.close();
    }
    return;
  }
  if (["purging", "discarding"].includes(record.phase)) {
    const parent = await openParent(trash.native, record.location.file);
    try {
      if (inodeIdentity(await parent.stat()) !== record.location.parentIdentity)
        throw treeConflict();
      const root = await inspect(
        trash.native,
        parent.handle,
        path.basename(record.location.file),
      );
      if (!root) {
        if (
          !trash.store
            .trashItems(record.id)
            .some((row) => !row.relativePath && row.removed)
        )
          throw treeConflict();
      } else {
        if (inodeIdentity(root) !== record.location.identity) throw treeConflict();
        const source = { parent, name: path.basename(record.location.file) };
        const rows = await remaining(trash, record, source);
        await removeTree(trash.native, parent, source.name, rows, {
          limits: trash.limits,
          mutate: (fn) => trash.barrier.run(fn),
          report: ({ entry }) =>
            trash.store.putTrashItem(record.id, entry.relativePath, entry),
        });
      }
      await trash.finish(record);
    } finally {
      await parent.close();
    }
    return;
  }
  if (!record.location || !record.sourceManifest) throw treeConflict();
  if (
    !record.recoveryId &&
    record.location.identity &&
    record.location.identity !== record.sourceManifest[0].identity
  ) {
    const original = await openTreeSource(
      record.scope,
      record.originalPath,
      trash.native,
    );
    const staged = await openTrashPayload(trash.native, record);
    try {
      await original.assertAuthority();
      if (inodeIdentity(await original.parent.stat()) !== record.sourceParentIdentity)
        throw treeConflict();
      await assertTree(
        trash.native,
        original.parent,
        original.name,
        record.sourceManifest,
        { limits: trash.limits },
      );
      const rows = await scanTree(trash.native, staged.parent, staged.name, {
        limits: trash.limits,
      });
      const recorded = new Map(
        trash.store
          .trashItems(record.id)
          .map((row) => [row.relativePath, row.targetIdentity]),
      );
      recorded.set("", record.location.identity);
      if (rows.some((row) => recorded.get(row.relativePath) !== row.identity))
        throw treeConflict();
      record.payloadManifest = rows;
      record.phase = "discarding";
      await trash.barrier.run(() => {
        trash.store.clearTrashItems(record.id);
        trash.store.putTrash(record);
      });
      await removeTree(trash.native, staged.parent, staged.name, rows, {
        limits: trash.limits,
        mutate: (fn) => trash.barrier.run(fn),
        report: ({ entry }) =>
          trash.store.putTrashItem(record.id, entry.relativePath, entry),
      });
      await trash.finish(record);
    } finally {
      await original.parent.close();
      await staged.parent.close();
    }
    return;
  }
  // A rename can succeed before its identity update reaches the journal. Only the
  // pre-recorded source inode and full manifest can establish that state.
  const location = { ...record.location, identity: record.sourceManifest[0].identity };
  const source = await openTrashPayload(trash.native, { ...record, location });
  try {
    const rows = await scanTree(trash.native, source.parent, source.name, {
      limits: trash.limits,
    });
    stable(rows, record.sourceManifest);
    record.location = location;
    record.payloadManifest = rows;
    await trash.barrier.run(async () => {
      await source.parent.sync();
      record.phase = "recoverable";
      await trash.save(record);
    });
  } finally {
    await source.parent.close();
  }
}

/** Startup replay only, before file job admission. Each disposition holds short
 * physical mutation leases; unknown paths/identities remain discoverable/pinned. */
export async function recoverTrash(trash) {
  let cursor;
  const outcomes = [];
  do {
    const page = trash.store.listTrashRecords(
      { kind: "global", id: "private-recovery" },
      cursor,
    );
    cursor = page.nextCursor;
    for (const summary of page.entries) {
      const record = trash.store.getTrash(summary.id);
      if (!record) continue;
      try {
        await recoverEntry(trash, record);
        outcomes.push({
          id: record.id,
          phase: trash.store.getTrash(record.id)?.phase || "resolved",
        });
      } catch {
        outcomes.push({
          id: record.id,
          phase: record.phase,
          issue: { code: "FILE_INTERRUPTED", args: {} },
        });
      }
    }
  } while (cursor);
  return outcomes;
}
