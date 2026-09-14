import { randomUUID } from "node:crypto";
import { fileProblem } from "./file-errors.js";
import { ownedHandle, inodeIdentity, openParent } from "./file-stage.js";
import { entryRevision } from "./file-paths.js";
import { extractCheckpoint } from "./file-extract-store.js";
import { assertExtractParent } from "./file-extract-plan.js";

export const sameNamePolicy = (a, b) =>
  a.device === b.device &&
  a.filesystem === b.filesystem &&
  a.volume === b.volume &&
  a.mount === b.mount &&
  a.caseFlags === b.caseFlags;

export async function proveExtractParents(owner, context, plan) {
  const publisher = owner.publisher,
    native = publisher.native;
  for (const parent of plan.parents.values()) {
    context.signal.throwIfAborted();
    await assertExtractParent(owner, context.scope, parent);
    const group = randomUUID(),
      root = parent.rows[0];
    const selectedParent = await openParent(native, root.selected.absolute);
    let actual;
    try {
      actual = await native.run("namePolicy", { handle: selectedParent.handle });
    } finally {
      await selectedParent.close();
    }
    if (actual.identity !== inodeIdentity(parent.selected.stat))
      throw fileProblem("FILE_PATH_CHANGED", 409);
    for (const row of parent.rows)
      await extractCheckpoint(publisher, context.jobId, row, { extractProbe: group });
    let stage, failure;
    try {
      stage = await publisher.stage(context.scope, root.path, {
        jobId: context.jobId,
        type: "directory",
        extract: { role: "probe", rootId: root.id, group },
      });
      const stat = await stage.handle.stat();
      await publisher.barrier.run(() => {
        const record = publisher.store.getPublication(stage.id);
        record.document.extractRoot = {
          stageId: stage.id,
          type: "directory",
          phase: "verified",
          identity: inodeIdentity(stat),
          revision: entryRevision(stat),
        };
        publisher.store.putPublication(record);
      });
      const bound = await native.run("namePolicy", {
        handle: stage.targetParentHandle.handle,
      });
      const probe = await native.run("namePolicy", { handle: stage.handle.handle });
      if (
        bound.identity !== actual.identity ||
        !sameNamePolicy(actual, bound) ||
        !sameNamePolicy(actual, probe)
      )
        throw fileProblem("FILE_EXTRACT_UNSUPPORTED", 409);
      parent.proof = actual;
      for (const row of parent.rows) {
        context.signal.throwIfAborted();
        await extractCheckpoint(publisher, context.jobId, row, {
          witness: { stageId: stage.id, phase: "creating" },
        });
        let handle;
        try {
          handle = ownedHandle(
            native,
            await native.run("createFile", {
              directory: stage.handle.handle,
              name: row.effectiveName,
            }),
          );
          const stat = await handle.stat();
          await extractCheckpoint(publisher, context.jobId, row, {
            witness: {
              stageId: stage.id,
              phase: "verified",
              identity: inodeIdentity(stat),
              revision: entryRevision(stat),
              type: "file",
            },
          });
        } catch (error) {
          if (error.code !== "FILE_EXISTS") throw error;
          await extractCheckpoint(publisher, context.jobId, row, {
            witness: { stageId: stage.id, phase: "not_created" },
          });
          throw fileProblem("FILE_ARCHIVE_ALIAS", 400);
        } finally {
          await handle?.close();
        }
      }
      await stage.handle.sync();
      const fresh = await native.run("namePolicy", {
        handle: stage.targetParentHandle.handle,
      });
      if (!sameNamePolicy(actual, fresh) || fresh.identity !== actual.identity)
        throw fileProblem("FILE_PATH_CHANGED", 409);
      await publisher.barrier.run(() => {
        const record = publisher.store.getPublication(stage.id);
        record.document.extractPolicy = actual;
        record.document.extractNamesValidated = parent.rows.length;
        publisher.store.putPublication(record);
      });
      parent.probeId = stage.id;
    } catch (error) {
      failure = error;
      throw error;
    } finally {
      if (stage)
        await publisher.discard(stage).catch((error) => {
          if (!failure) throw error;
        });
    }
  }
}

export async function revalidateExtractPolicy(owner, context, parent) {
  await assertExtractParent(owner, context.scope, parent);
  const handle = await openParent(
    owner.publisher.native,
    parent.rows[0].selected.absolute,
  );
  try {
    const current = await owner.publisher.native.run("namePolicy", {
      handle: handle.handle,
    });
    if (
      !parent.proof ||
      current.identity !== parent.proof.identity ||
      !sameNamePolicy(current, parent.proof)
    )
      throw fileProblem("FILE_PATH_CHANGED", 409);
  } finally {
    await handle.close();
  }
}
