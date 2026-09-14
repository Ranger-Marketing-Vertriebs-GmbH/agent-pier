import path from "node:path";
import crc32 from "buffer-crc32";
import { ownedHandle, inodeIdentity, contentIdentity } from "./file-stage.js";
import { entryRevision } from "./file-paths.js";
import { fileProblem } from "./file-errors.js";
import { nativeReadBytes } from "./file-native.js";
import { extractCheckpoint } from "./file-extract-store.js";
import { treeParent } from "./file-tree.js";
import { retryTargetGuard } from "./file-retry-targets.js";

export async function decodeExtractEntry(
  owner,
  context,
  source,
  row,
  handle,
  stageId,
  budget,
) {
  const entry = source.entries.get(row.relative);
  if (!entry) return; // implicit directory
  context.signal.throwIfAborted();
  const stream = await source.stream(entry);
  let size = 0,
    checksum;
  const abort = () => stream.destroy(context.signal.reason);
  stream.on("error", () => {});
  context.signal.addEventListener("abort", abort, { once: true });
  try {
    context.signal.throwIfAborted();
    for await (const chunk of stream) {
      for (let offset = 0; offset < chunk.length; offset += nativeReadBytes) {
        context.signal.throwIfAborted();
        const bytes = chunk.subarray(offset, offset + nativeReadBytes);
        if (
          size + bytes.length > row.size ||
          size + bytes.length > owner.limits.uploadBytes ||
          budget.bytes + bytes.length > owner.limits.jobBytes
        )
          throw fileProblem("FILE_LIMIT_EXCEEDED", 413);
        size += bytes.length;
        budget.bytes += bytes.length;
        await context.report({ completedBytes: budget.bytes });
        if (handle) {
          await handle.writeFile(bytes);
          const stat = await handle.stat();
          await extractCheckpoint(owner.publisher, context.jobId, row, {
            payload: {
              stageId,
              type: row.type,
              phase: "verified",
              identity: inodeIdentity(stat),
              revision: entryRevision(stat),
            },
          });
        }
        checksum = crc32(bytes, checksum);
      }
    }
    if (size !== row.size || crc32.unsigned(Buffer.alloc(0), checksum) !== entry.crc32)
      throw fileProblem("FILE_ARCHIVE_INVALID", 400);
  } catch (error) {
    if (error.code?.startsWith("FILE_") || context.signal.aborted) throw error;
    throw fileProblem("FILE_ARCHIVE_INVALID", 400);
  } finally {
    context.signal.removeEventListener("abort", abort);
    const closed = stream.closed
      ? null
      : new Promise((resolve) => stream.once("close", resolve));
    stream.destroy();
    await closed;
  }
}

export async function prepareExtractGroup(owner, context, source, group, budget) {
  const publisher = owner.publisher,
    native = publisher.native;
  const indexed = new Map();
  let stage;
  try {
    stage = await publisher.stage(context.scope, group.root.path, {
      jobId: context.jobId,
      type: group.root.type,
      targetGuard: retryTargetGuard(context),
      extract: { role: "output", rootId: group.root.id, group: group.id },
    });
    group.stageId = stage.id;
    const initial = await stage.handle.stat();
    await extractCheckpoint(publisher, context.jobId, group.root, {
      payload: {
        stageId: stage.id,
        type: group.root.type,
        phase: "verified",
        identity: inodeIdentity(initial),
        revision: entryRevision(initial),
      },
    });
    indexed.set("", { identity: inodeIdentity(initial) });
    for (const row of group.rows) {
      context.signal.throwIfAborted();
      let parent, handle;
      try {
        if (!row.groupRelative) handle = stage.handle;
        else {
          parent = await treeParent(
            native,
            stage.parentHandle,
            stage.name,
            row.groupRelative,
            indexed,
          );
          await extractCheckpoint(publisher, context.jobId, row, {
            payload: { stageId: stage.id, phase: "creating" },
          });
          try {
            handle = ownedHandle(
              native,
              await native.run(
                row.type === "directory" ? "createDirectory" : "createFile",
                {
                  directory: parent.handle,
                  name: path.posix.basename(row.groupRelative),
                },
              ),
            );
          } catch (error) {
            if (error.code !== "FILE_EXISTS") throw error;
            await extractCheckpoint(publisher, context.jobId, row, {
              payload: { stageId: stage.id, phase: "not_created" },
            });
            throw fileProblem("FILE_ARCHIVE_ALIAS", 400);
          }
        }
        const checkpoint = async () => {
          const stat = await handle.stat();
          await extractCheckpoint(publisher, context.jobId, row, {
            payload: {
              stageId: stage.id,
              type: row.type,
              phase: "verified",
              identity: inodeIdentity(stat),
              revision: entryRevision(stat),
            },
          });
          indexed.set(row.groupRelative, { identity: inodeIdentity(stat) });
        };
        await checkpoint();
        await decodeExtractEntry(
          owner,
          context,
          source,
          row,
          row.type === "file" ? handle : null,
          stage.id,
          budget,
        );
        await handle.sync();
        await checkpoint();
      } finally {
        if (handle && handle !== stage.handle) await handle.close();
        await parent?.close();
      }
    }
    for (const row of [...group.rows]
      .reverse()
      .filter((item) => item.type === "directory" && item.groupRelative)) {
      const parent = await treeParent(
        native,
        stage.parentHandle,
        stage.name,
        row.groupRelative,
        indexed,
      );
      let handle;
      try {
        handle = ownedHandle(
          native,
          await native.run("openLookup", {
            directory: parent.handle,
            path: path.posix.basename(row.groupRelative),
          }),
        );
        await handle.sync();
        const stat = await handle.stat();
        if (inodeIdentity(stat) !== row.payload.identity)
          throw fileProblem("FILE_PATH_CHANGED", 409);
        await extractCheckpoint(publisher, context.jobId, row, {
          payload: { ...row.payload, revision: entryRevision(stat) },
        });
      } finally {
        await handle?.close();
        await parent.close();
      }
    }
    await stage.handle.sealWrites();
    await stage.handle.sync();
    const stat = await stage.handle.stat();
    await extractCheckpoint(publisher, context.jobId, group.root, {
      payload: {
        ...group.root.payload,
        revision: entryRevision(stat),
        content: contentIdentity(stat),
      },
    });
    await publisher.release(stage);
    stage = null;
  } catch (error) {
    if (stage)
      await publisher
        .discard(stage)
        .catch(() => publisher.release(stage).catch(() => {}));
    throw error;
  }
}
