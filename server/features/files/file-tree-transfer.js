import path from "node:path";
import { createHash } from "node:crypto";
import { resolveFile, assertFileMutationTarget, entryRevision } from "./file-paths.js";
import { readFileLimits } from "./file-limits.js";
import { copyMetadata } from "./file-metadata.js";
import {
  closeHandles,
  ownedHandle,
  openParent,
  inodeIdentity,
  parentMatches,
  inspect,
} from "./file-stage.js";
import {
  scanTree,
  assertTree,
  removeTree,
  treeParent,
  treeName,
  treeConflict,
  treeRow,
} from "./file-tree.js";

const privateSources = new WeakMap();
// Internal capability only: never serialized, returned by HTTP, or accepted as a scope.
export function privateTreeSource(open) {
  const source = Object.freeze({});
  privateSources.set(source, open);
  return source;
}
export async function openTreeSource(scope, source, native) {
  if (privateSources.has(source)) return privateSources.get(source)(native);
  const selected = await resolveFile(scope, source, { followLeaf: false });
  assertFileMutationTarget(scope, selected);
  const parent = await openParent(native, selected.absolute);
  const parentIdentity = inodeIdentity(await parent.stat());
  const assertAuthority = async () => {
    const fresh = await resolveFile(scope, source, { followLeaf: false });
    assertFileMutationTarget(scope, fresh);
    if (
      fresh.absolute !== selected.absolute ||
      fresh.linkIdentity !== selected.linkIdentity ||
      !(await parentMatches(native, selected.absolute, parentIdentity))
    )
      throw treeConflict();
  };
  try {
    if (
      entryRevision(
        await inspect(native, parent.handle, path.basename(selected.absolute)),
      ) !== entryRevision(selected.stat)
    )
      throw treeConflict();
    return { parent, name: path.basename(selected.absolute), assertAuthority };
  } catch (error) {
    await parent.close();
    throw error;
  }
}

/** Copies into a publisher/private-owner stage using its worker. The source is
 * retained until the caller explicitly invokes removeMatchingSource after commit.
 * report receives bounded private entry checkpoints and optional localized issues.
 */
export async function copyVerified(
  scope,
  source,
  stage,
  {
    limits = readFileLimits(),
    signal,
    report = async () => {},
    strictMetadata = true,
    mutate = (fn) => fn(),
  } = {},
) {
  const native = stage.parentHandle.native;
  const selected = await openTreeSource(scope, source, native);
  const manifest = [],
    targets = [];
  try {
    const rows = await scanTree(native, selected.parent, selected.name, {
      limits,
      signal,
    });
    if (rows[0].type !== stage.type) throw treeConflict();
    for (const row of rows) {
      signal?.throwIfAborted();
      const from = await treeParent(
        native,
        selected.parent,
        selected.name,
        row.relativePath,
        rows,
      );
      let to;
      try {
        to = await treeParent(
          native,
          stage.parentHandle,
          stage.name,
          row.relativePath,
          targets,
        );
      } catch (error) {
        await from.close();
        throw error;
      }
      let input, output;
      try {
        input = ownedHandle(
          native,
          await native.run(
            row.type === "directory"
              ? "openLookup"
              : row.type === "symlink"
                ? "openLink"
                : "openFile",
            { directory: from.handle, path: treeName(selected.name, row.relativePath) },
          ),
        );
        if (entryRevision(await input.stat()) !== row.revision) throw treeConflict();
        const targetName = treeName(stage.name, row.relativePath);
        if (row.type === "symlink") {
          const text = await native.run("readLink", { handle: input.handle });
          if (!row.relativePath) await stage.createLink(text);
          else
            await native.run("createLink", {
              directory: to.handle,
              name: targetName,
              text,
            });
          output = ownedHandle(
            native,
            await native.run("openLink", { directory: to.handle, path: targetName }),
          );
        } else if (!row.relativePath) output = stage.handle;
        else
          output = ownedHandle(
            native,
            await native.run(
              row.type === "directory" ? "createDirectory" : "createFile",
              { directory: to.handle, name: targetName },
            ),
          );
        const target = treeRow(row.relativePath, await output.stat());
        targets.push(target);
        await report({
          entry: { ...row, targetIdentity: target.identity, phase: "copying" },
        });
        if (row.type === "file") {
          const hash = createHash("sha256"),
            bytes = Buffer.alloc(65536);
          for (let position = 0; position < row.size;) {
            signal?.throwIfAborted();
            const { bytesRead } = await input.read(
              bytes,
              0,
              Math.min(bytes.length, row.size - position),
              position,
            );
            if (!bytesRead) throw treeConflict();
            hash.update(bytes.subarray(0, bytesRead));
            await output.writeFile(bytes.subarray(0, bytesRead));
            position += bytesRead;
          }
          await output.sync();
          const copied = createHash("sha256");
          for (let position = 0; position < row.size;) {
            const { bytesRead } = await output.read(
              bytes,
              0,
              Math.min(bytes.length, row.size - position),
              position,
            );
            if (!bytesRead) throw treeConflict();
            copied.update(bytes.subarray(0, bytesRead));
            position += bytesRead;
          }
          if (hash.digest("hex") !== copied.digest("hex")) throw treeConflict();
        }
        if (entryRevision(await input.stat()) !== row.revision) throw treeConflict();
        manifest.push({ ...row, targetIdentity: target.identity });
      } finally {
        await closeHandles(input, output !== stage.handle ? output : null, from, to);
      }
    }
    // Postorder metadata preserves directory times after children are populated.
    for (const row of [...rows].reverse()) {
      signal?.throwIfAborted();
      const from = await treeParent(
        native,
        selected.parent,
        selected.name,
        row.relativePath,
        rows,
      );
      let to;
      try {
        to = await treeParent(
          native,
          stage.parentHandle,
          stage.name,
          row.relativePath,
          targets,
        );
      } catch (error) {
        await from.close();
        throw error;
      }
      let input, output;
      try {
        const operation =
          row.type === "directory"
            ? "openLookup"
            : row.type === "symlink"
              ? "openLink"
              : "openFile";
        input = ownedHandle(
          native,
          await native.run(operation, {
            directory: from.handle,
            path: treeName(selected.name, row.relativePath),
          }),
        );
        output = ownedHandle(
          native,
          await native.run(operation, {
            directory: to.handle,
            path: treeName(stage.name, row.relativePath),
          }),
        );
        if (
          entryRevision(await input.stat()) !== row.revision ||
          inodeIdentity(await output.stat()) !==
            targets.find((target) => target.relativePath === row.relativePath).identity
        )
          throw treeConflict();
        const result = await copyMetadata(input, output, {
          strictOwnership: strictMetadata,
          preserveTimes: true,
        });
        for (const issue of result?.warnings || []) await report({ issue });
        if (row.type !== "symlink") await output.sync();
        await to.sync();
        await report({
          entry: {
            ...manifest.find((item) => item.relativePath === row.relativePath),
            phase: "verified",
          },
        });
      } finally {
        await closeHandles(input, output, from, to);
      }
    }
    await selected.assertAuthority();
    await assertTree(native, selected.parent, selected.name, rows, { limits, signal });
  } finally {
    await selected.parent.close();
  }
  const apply = async (remove) => {
    const current = await openTreeSource(scope, source, native);
    try {
      await current.assertAuthority();
      if (remove)
        await removeTree(native, current.parent, current.name, manifest, {
          limits,
          signal,
          report,
          mutate: (fn) =>
            mutate(async () => {
              await current.assertAuthority();
              await fn();
            }),
        });
      else
        await assertTree(native, current.parent, current.name, manifest, {
          limits,
          signal,
        });
    } finally {
      await current.parent.close();
    }
  };
  return {
    stage,
    manifest,
    assertSourceUnchanged: () => apply(false),
    removeMatchingSource: () => apply(true),
  };
}
